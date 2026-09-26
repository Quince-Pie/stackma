import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { PendingReviewError } from "../../scripts/release/amo.js";
import { UnresolvedReleaseError } from "../../scripts/release/repository.js";
import { approvalWaitMs, runSigning } from "../../scripts/release/sign.js";
import { temporary } from "./fixtures.js";

async function fixture(t, result) {
  const directory = await temporary(t);
  const context = { tag: "v1.1.5", commit: "c".repeat(40), version: "1.1.5", id: "stackma@extensions.local", channel: "listed" };
  await writeFile(`${directory}/context.json`, JSON.stringify(context));
  const env = { RELEASE_TAG: "v1.1.5", RELEASE_COMMIT: context.commit, GITHUB_OUTPUT: `${directory}/output`, GITHUB_STEP_SUMMARY: `${directory}/summary` };
  const logs = [], warnings = [], calls = [];
  const options = {
    retired: new Set(), // Synthetic versions must not inherit live repository retirements.
    env, directory, signedDirectory: `${directory}/signed`, client: {}, github: {}, log: line => logs.push(line), warn: line => warnings.push(line),
    sign: async request => { calls.push(request); if (result instanceof Error) throw result; return result; },
  };
  const read = async name => { try { return await readFile(`${directory}/${name}`, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  return { options, context, env, logs, warnings, calls, read };
}

test("a pending review ends successfully with an explicit state, summary and no signed record", async t => {
  const f = await fixture(t, { state: "awaiting-review", versionId: 42, fileStatus: "unreviewed" });
  assert.deepEqual(await runSigning(f.options), { state: "awaiting-review" });
  assert.equal(await f.read("output"), "state=awaiting-review\n");
  const summary = await f.read("summary");
  assert.match(summary, /Awaiting Mozilla review/u);
  assert.match(summary, /AMO version 42/u);
  assert.match(summary, /Resume approved releases/u);
  assert.match(summary, /tag v1\.1\.5/u);
  assert(f.logs.some(line => line.startsWith("::notice title=Awaiting Mozilla review::")));
  assert.equal(await f.read("signed/signing.json"), null);
  assert.equal(f.calls[0].approvalWaitMs, approvalWaitMs);
  assert(approvalWaitMs > 0 && approvalWaitMs < 20 * 60_000, "the wait must end before the client's hard deadline");
});

test("approval writes the unchanged signing record and the approved state", async t => {
  const record = { versionId: 42, signed: { sha256: "a".repeat(64), bytes: 10 }, license: { name: "WTFPL", sha256: "b".repeat(64), apiSha256: "d".repeat(64) } };
  const f = await fixture(t, { state: "approved-and-signed", ...record });
  assert.deepEqual(await runSigning(f.options), { state: "approved-and-signed" });
  assert.deepEqual(JSON.parse(await f.read("signed/signing.json")), { ...f.context, ...record });
  assert.equal(await f.read("output"), "state=approved-and-signed\n");
  assert.equal(await f.read("summary"), null);
});

test("another pending version stops submission with an escaped error annotation and no state", async t => {
  const f = await fixture(t, new PendingReviewError(["1.1.4"], "1.1.5"));
  assert.deepEqual(await runSigning(f.options), { state: "blocked-by-pending-review", pending: ["1.1.4"] });
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^::error title=Another version awaits Mozilla review::AMO version 1\.1\.4 /u);
  assert(!f.warnings[0].includes("\n") && f.warnings[0].includes("%0A"));
  assert.match(await f.read("summary"), /## Release not submitted[\s\S]*supersede 1\.1\.4/u);
  assert.equal(await f.read("output"), null);
  assert.equal(await f.read("signed/signing.json"), null);
});

test("unexpected signing errors still fail the step", async t => {
  const f = await fixture(t, new Error("Mozilla API returned HTTP 500"));
  await assert.rejects(() => runSigning(f.options), /HTTP 500/u);
  assert.equal(await f.read("output"), null);
});

test("an ambiguous earlier release is a failed resumable barrier, never approval", async t => {
  const f = await fixture(t, new UnresolvedReleaseError(["v1.1.4"]));
  assert.deepEqual(await runSigning(f.options), { state: "blocked-by-unresolved-release", tags: ["v1.1.4"] });
  assert.match(f.warnings[0], /Earlier release outcome is unresolved/u);
  assert.match(await f.read("summary"), /request may still be running/u);
  assert.equal(await f.read("output"), null);
  assert.equal(await f.read("signed/signing.json"), null);
  assert.equal(typeof f.calls[0].checkPriorReleases, "function");
});

test("supersede accepts only another canonical version and identity mismatches stop before signing", async t => {
  const f = await fixture(t, { state: "awaiting-review", versionId: 42, fileStatus: "unreviewed" });
  for (const supersede of ["v1.1.4", "latest", "1.1.4 ", "01.1.4"]) {
    await assert.rejects(() => runSigning({ ...f.options, env: { ...f.env, SUPERSEDE_PENDING: supersede } }), /supersede must be the AMO version|stable vMAJOR/u);
  }
  await assert.rejects(() => runSigning({ ...f.options, env: { ...f.env, SUPERSEDE_PENDING: "1.1.5" } }), /cannot supersede itself/u);
  await assert.rejects(() => runSigning({ ...f.options, env: { ...f.env, RELEASE_TAG: "v1.1.6" } }));
  assert.equal(f.calls.length, 0);
  await runSigning({ ...f.options, env: { ...f.env, SUPERSEDE_PENDING: "1.1.4" } });
  assert.equal(f.calls[0].supersede, "1.1.4");
});
