import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../release/package.js";

// A narrow bridge for actionlint 1.7.12's missing concurrency.queue support.
// Check the exact literal policy we use, not an invented general YAML parser.
// GitHub's queue=max requires cancel-in-progress=false and retains 100 waiters.
export function verifyQueuePolicy(workflow, group = "stackma-release") {
  assert(["stackma-release", "stackma-release-preparation"].includes(group));
  assert.match(workflow, new RegExp(`^concurrency:\\n  group: ${group}\\n  cancel-in-progress: false\\n  queue: max\\n`, "mu"),
    "Keep the reviewed release queue policy until actionlint supports concurrency.queue");
  assert.equal([...workflow.matchAll(/^\s*queue:/gmu)].length, 1, "Unexpected unvalidated queue property");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verifyQueuePolicy(await readFile(".github/workflows/release.yml", "utf8"));
  verifyQueuePolicy(await readFile(".github/workflows/prepare-release.yml", "utf8"), "stackma-release-preparation");
  const result = await run("actionlint", [], { timeout: 60_000 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
