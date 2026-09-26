import assert from "node:assert/strict";
import { compareReleaseTags, run, validateMetadata, versionFromTag } from "./package.js";

// Distribution authority comes from the frozen reviewed source, never a CLI
// channel override. Existing sources without an exception retain listed behavior.
export async function releaseChannelAt(tag, commit, cwd = process.cwd()) {
  versionFromTag(tag);
  assert.match(commit, /^[a-f0-9]{40}$/u);
  const git = async args => (await run("git", args, { cwd, timeout: 30_000 })).stdout;
  const path = `release-exceptions/${tag}.json`;
  const entry = await git(["ls-tree", commit, "--", path]);
  if (entry === "") return "listed";
  assert.match(entry, /^100644 blob [a-f0-9]{40}\t[^\n]+\n$/u, "Unlisted authority must be an ordinary committed file");
  const text = await git(["show", `${commit}:${path}`]);
  const record = JSON.parse(text);
  assert.match(record.base ?? "", /^[a-f0-9]{40}$/u);
  assert.equal(text, JSON.stringify({ schema: 1, tag, channel: "unlisted", base: record.base }, null, 2) + "\n",
    "Unexpected unlisted release authority");
  await git(["merge-base", "--is-ancestor", record.base, commit]);
  const metadata = async revision => Promise.all(["extension/manifest.json", "package.json", "package-lock.json"]
    .map(async file => JSON.parse(await git(["show", `${revision}:${file}`]))));
  const before = await metadata(record.base), after = await metadata(commit);
  const previous = before[0].version;
  validateMetadata(`v${previous}`, ...before); validateMetadata(tag, ...after);
  assert(compareReleaseTags(`v${previous}`, tag) < 0, "Unlisted version must increase");
  after[0].version = after[1].version = after[2].version = after[2].packages[""].version = previous;
  assert.deepEqual(after, before, "Unlisted release must change only product versions");
  const changed = (await git(["diff", "--name-only", record.base, commit, "--", "extension", "naming-data", "LICENSE"])).trim();
  assert.equal(changed, "extension/manifest.json", "Unlisted release changes product code, data or licensing");
  return "unlisted";
}
