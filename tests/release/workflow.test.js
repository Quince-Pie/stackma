import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { publicationJobName, publicationVerificationStepName, releaseWorkflow } from "../../scripts/release/resume.js";

// These workflow strings are contracts with scripts in other files.
const release = await readFile(`.github/workflows/${releaseWorkflow}`, "utf8");
const resume = await readFile(".github/workflows/resume-release.yml", "utf8");

test("merged release initiation uses trusted default-branch context and retains all authority guards", () => {
  assert.match(release, /^  pull_request_target:\n    types: \[closed\]\n    branches: \[main\]/mu);
  assert(!/^  pull_request:/mu.test(release));
  assert.match(release, /github\.event\.pull_request\.merged == true/u);
  assert.match(release, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(release, /startsWith\(github\.event\.pull_request\.head\.ref, 'release\/v'\)/u);
  assert(!release.includes("allow-unsafe-pr-checkout"));
  assert(!release.includes("github.event.pull_request.head.sha"));
});

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

test("Chrome Web Store submission is keyless, isolated and runs only reviewed controller code", async () => {
  const chrome = release.slice(release.indexOf("\n  chrome:"), release.indexOf("\n  publish:"));
  assert.match(chrome, /needs: \[resolve, verify, tag\]/u);
  assert.match(chrome, /environment: release-chrome-web-store/u);
  assert.deepEqual([...chrome.matchAll(/^ {6}([\w-]+): (read|write)/gmu)].map(match => `${match[1]}:${match[2]}`), ["contents:read", "id-token:write"]);
  assert(!/secrets\./u.test(chrome), "workload identity federation needs no stored credential");
  assert.match(chrome, /ref: \$\{\{ github\.sha \}\}/u);
  assert(!chrome.includes("release-source"), "no frozen or historical script runs with the store credential");
  assert(!chrome.includes("npm ci"), "the credentialed job installs no npm dependencies");
  assert.match(chrome, /artifact-ids: \$\{\{ needs\.verify\.outputs\.release-input-id \}\}\n\s+path: artifacts\/release-input\n\s+digest-mismatch: error/u);
  assert.match(chrome, /CHROME_SUPERSEDE_PENDING: \$\{\{ inputs\.chrome-supersede \}\}/u);
  assert.match(chrome, /nix develop \.#release --no-update-lock-file --command node scripts\/release\/chrome-submit\.js$/mu);
  for (const name of ["CWS_PUBLISHER_ID", "CWS_ITEM_ID", "CWS_WORKLOAD_IDENTITY_PROVIDER", "CWS_SERVICE_ACCOUNT"]) {
    assert.match(chrome, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`, "u"));
  }
  // The GitHub release never waits on the store, and the store never gates it.
  const publish = release.slice(release.indexOf("\n  publish:"));
  assert.match(publish, /needs: \[resolve, sign\]/u);
});

test("only the Chrome Web Store job can request an OIDC token", async () => {
  // The Google trust condition admits this repository's main-branch jobs; the
  // repository keeps that set to the one environment-gated job.
  const workflows = [".github/workflows/ci.yml", ".github/workflows/prepare-release.yml", ".github/workflows/release.yml", ".github/workflows/resume-release.yml"];
  const grants = [];
  for (const path of workflows) {
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(/^\s+id-token:\s*(\S+)/gmu)) grants.push({ path, value: match[1], at: match.index });
  }
  assert.deepEqual(grants.map(({ path, value }) => `${path}:${value}`), [".github/workflows/release.yml:write"]);
  const chrome = release.indexOf("\n  chrome:"), publish = release.indexOf("\n  publish:");
  assert(grants[0].at > chrome && grants[0].at < publish, "id-token: write belongs to the chrome job only");
  assert(!/^permissions:[^\n]*\n(?:\s+.*\n)*?\s+id-token/mu.test(release.slice(0, release.indexOf("\njobs:"))), "no workflow-level id-token grant");
});

test("CI verifies the Chrome package only for sources that contain it", async () => {
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  const chromeSteps = [...ci.matchAll(/- name: ([^\n]*Chrome[^\n]*)\n\s+(?:if: ([^\n]+))?/gu)];
  assert(chromeSteps.length >= 5);
  for (const [, name, condition] of chromeSteps) {
    assert.equal(condition, "${{ hashFiles('chrome/manifest.json') != '' }}", `${name} must skip historical sources`);
  }
  assert.match(ci, /--output=artifacts\/ci\/chrome-package\.json/u);
  assert.match(ci, /--output=artifacts\/ci\/chrome-minimum\.json/u);
});

test("the scheduler holds only read access plus workflow dispatch, on main", () => {
  assert.match(resume, /^permissions:\n  contents: read\n\n/mu);
  assert.deepEqual([...resume.matchAll(/^ {6}(\w+): (read|write)/gmu)].map(match => `${match[1]}:${match[2]}`), ["contents:read", "actions:write"]);
  assert.match(resume, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/u);
  assert.match(resume, /nix develop \.#release --no-update-lock-file --command node scripts\/release\/resume\.js$/mu);
  assert(!/secrets\./u.test(resume), "the scheduler needs no AMO or other secrets");
});
