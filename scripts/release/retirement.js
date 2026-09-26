import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { versionFromTag } from "./package.js";

// A reviewed controller policy, separate from immutable source intent. It is
// never written automatically. The maintainer must establish no provider write
// remains in flight; absence from a version GET is not evidence of cancellation.
export function retiredTags(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "Invalid release retirement policy");
  const entries = Object.entries(value);
  assert(entries.length <= 1000, "Release retirement policy exceeds its record bound");
  for (const [tag, record] of entries) {
    versionFromTag(tag);
    assert(record && typeof record === "object" && !Array.isArray(record), "Invalid release retirement record");
    assert.deepEqual(Object.keys(record).sort(), ["evidence", "noInFlightRequests", "reason"]);
    assert(record.noInFlightRequests === true, "Retirement requires established absence of in-flight provider writes");
    for (const field of ["reason", "evidence"]) {
      assert(typeof record[field] === "string" && record[field].trim().length > 0 && record[field].length <= 2000,
        "Retirement requires a bounded reason and evidence of the resolved outcome");
    }
  }
  return new Set(entries.map(([tag]) => tag));
}

export async function readRetirements(path = new URL("../../release-retirements.json", import.meta.url)) {
  const text = await readFile(path, "utf8");
  assert(Buffer.byteLength(text) <= 4 * 1024 * 1024, "Retirement policy exceeds its size bound");
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("Release retirement policy is not valid JSON"); }
  return retiredTags(value);
}
