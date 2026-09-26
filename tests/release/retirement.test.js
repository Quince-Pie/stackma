import assert from "node:assert/strict";
import test from "node:test";
import { retiredTags } from "../../scripts/release/retirement.js";
import { requireResolvedPriorReleases, UnresolvedReleaseError } from "../../scripts/release/repository.js";
import { runSigning } from "../../scripts/release/sign.js";
import { writeFile } from "node:fs/promises";
import { temporary } from "./fixtures.js";

const record = { reason: "Build failed before submission; replaced by a corrected version", evidence: "Maintainer checked all publishing attempts; no version-create request started", noInFlightRequests: true };

test("retirement requires a named version, resolved requests and reviewable evidence", () => {
  assert.deepEqual([...retiredTags({ "v1.1.5": record })], ["v1.1.5"]);
  for (const value of [[], null, { "v1.1.5": {} }, { "v1.1.5": { ...record, noInFlightRequests: false } },
    { "v1.1.5": { ...record, reason: "" } }, { "v1.1.5": { ...record, evidence: "" } }, { "v01.1.5": record }]) assert.throws(() => retiredTags(value));
});

test("explicit retirement clears only that prior intent; unknown work still blocks", async () => {
  const github = { async releases() { return []; } };
  const retired = retiredTags({ "v1.1.5": record });
  await requireResolvedPriorReleases(github, "v1.1.6", [], ["v1.1.5"], retired);
  await assert.rejects(() => requireResolvedPriorReleases(github, "v1.1.7", [], ["v1.1.5", "v1.1.6"], retired), error =>
    error instanceof UnresolvedReleaseError && error.tags.join() === "v1.1.6");
});

test("the current signer refuses retired targets before any provider action", async t => {
  const directory = await temporary(t);
  const context = { tag: "v1.1.5", commit: "a".repeat(40), version: "1.1.5", id: "stackma@extensions.local", channel: "listed" };
  await writeFile(`${directory}/context.json`, JSON.stringify(context));
  await assert.rejects(() => runSigning({ directory, env: { RELEASE_TAG: context.tag, RELEASE_COMMIT: context.commit },
    retired: retiredTags({ [context.tag]: record }), sign: async () => assert.fail("retired release must not call a provider") }), /explicitly retired/u);
});
