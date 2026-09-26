import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { publicationJobName, publicationVerificationStepName, releaseWorkflow } from "../../scripts/release/resume.js";

// These workflow strings are contracts with scripts in other files.
const release = await readFile(`.github/workflows/${releaseWorkflow}`, "utf8");
const resume = await readFile(".github/workflows/resume-release.yml", "utf8");

test("dispatch runs carry the exact title that automatic resumption counts", () => {
  assert.match(release, /^run-name: \$\{\{ github\.event_name == 'workflow_dispatch' && format\('Publish release \{0\}', inputs\.tag\) \|\| github\.event\.pull_request\.title \}\}$/mu);
});

test("the scheduler identifies the actual publication verification gate", () => {
  assert(release.includes(`    name: ${publicationJobName}\n`));
  assert(release.includes(`      - name: ${publicationVerificationStepName}\n`));
});

test("missing-tag recovery reads a merged PR without granting resolver write permissions", () => {
  const resolve = release.slice(release.indexOf("\n  resolve:"), release.indexOf("\n  verify:"));
  assert.match(resolve, /pull-requests: read/u);
  assert.match(resolve, /RECOVERY_PR: \$\{\{ inputs\.pull-request \}\}/u);
  assert(!/^\s+\S+: write/mu.test(resolve));
});

test("only explicit approval permits signed verification and publication", () => {
  // Missing or unknown outputs must fail closed. Historical signers are never
  // executed; the current controller emits this state for old and new releases.
  const conditions = [...release.matchAll(/^\s+if: (.*)$/gmu)].map(match => match[1]);
  assert.deepEqual(conditions.filter(condition => condition.includes("state")), [
    "steps.amo.outputs.state == 'approved-and-signed'",
    "steps.amo.outputs.state == 'approved-and-signed'",
    "needs.sign.outputs.state == 'approved-and-signed'",
  ]);
  assert.match(release, /- name: Submit or resume Mozilla signing\n\s+id: amo\n/u);
  assert.match(release, /^\s+state: \$\{\{ steps\.amo\.outputs\.state \}\}$/mu);
  assert.match(release, /^\s+SUPERSEDE_PENDING: \$\{\{ inputs\.supersede \}\}$/mu);
});

test("recovery executes the reviewed controller against frozen product files", async () => {
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  const sign = release.slice(release.indexOf("\n  sign:"), release.indexOf("\n  publish:"));
  assert.match(sign, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(sign, /ref: \$\{\{ needs\.resolve\.outputs\.commit \}\}\n\s+path: release-source/u);
  assert.match(sign, /node scripts\/package-test\.js --source-root=release-source --signed/u);
  assert(!sign.includes("node release-source/"), "historical scripts must not run with signing credentials");
  assert.match(ci, /ref: \$\{\{ github\.sha \}\}\n\s+path: \.release-controller/u);
  assert.equal([...ci.matchAll(/node \.release-controller\/scripts\/release\/stage\.js/g)].length, 2);
});

test("the scheduler holds only read access plus workflow dispatch, on main", () => {
  assert.match(resume, /^permissions:\n  contents: read\n\n/mu);
  assert.deepEqual([...resume.matchAll(/^ {6}(\w+): (read|write)/gmu)].map(match => `${match[1]}:${match[2]}`), ["contents:read", "actions:write"]);
  assert.match(resume, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/u);
  assert.match(resume, /nix develop \.#release --no-update-lock-file --command node scripts\/release\/resume\.js$/mu);
  assert(!/secrets\./u.test(resume), "the scheduler needs no AMO or other secrets");
});
