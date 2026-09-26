import assert from "node:assert/strict";
import { run, versionFromTag } from "./package.js";

const shaPattern = /^[a-f0-9]{40}$/u;
const maximumIntents = 1000;
const git = async (args, cwd) => (await run("git", args, {
  cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
})).stdout;

export function intentPath(tag) {
  versionFromTag(tag);
  return `release-intents/${tag}.json`;
}

export function intentText(tag) {
  versionFromTag(tag);
  return JSON.stringify({ schema: 1, tag }, null, 2) + "\n";
}

const compareTags = (left, right) => {
  const a = versionFromTag(left).split(".").map(Number);
  const b = versionFromTag(right).split(".").map(Number);
  const index = a.findIndex((part, i) => part !== b[i]);
  return index < 0 ? 0 : a[index] - b[index];
};

/**
 * Read release intent from the selected source, never the working tree or
 * mutable remote tag listing. Full-history callers also establish that main's
 * admitted records were never changed or removed. Tree-only callers may use a
 * shallow checkout after the resolver has checked that history.
 */
export async function intentTagsAt(commit, cwd, { checkHistory = false } = {}) {
  assert.match(commit, shaPattern);
  if (checkHistory) {
    assert.equal((await git(["rev-parse", "--is-shallow-repository"], cwd)).trim(), "false",
      "Release intent history requires a complete checkout");
    // Explicit first-parent merge diffs compare a merged source against the
    // previous protected main tree. Disable renames so moving a record is a
    // deletion, including a move out of the inventory directory. A corrected
    // later tree cannot hide an earlier deletion or edit.
    const changed = await git(["log", "--first-parent", "--full-history", "--diff-merges=first-parent", "--root",
      "--format=", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color",
      "--diff-filter=DMRT", commit, "--", "release-intents"], cwd);
    assert(changed === "", "Release intent history contains a modified, deleted, renamed or replaced record; inspect main history");
  }
  const root = await git(["ls-tree", "-z", commit, "--", "release-intents"], cwd);
  if (root === "") return null;
  assert.match(root, /^040000 tree [a-f0-9]{40}\trelease-intents\0$/u, "Release intents must be a directory");
  const listing = await git(["ls-tree", "-r", "-t", "-l", "-z", `${commit}:release-intents`], cwd);
  const entries = listing.split("\0").filter(Boolean);
  assert(entries.length > 0 && entries.length <= maximumIntents, "Release intent inventory must contain 1 to 1000 records");
  const tags = [], blobs = [], texts = [];
  for (const entry of entries) {
    const match = /^100644 blob ([a-f0-9]{40}) +([0-9]+)\t(v[^/]+)\.json$/u.exec(entry);
    assert(match, "Release intent records must be ordinary flat JSON files");
    const [, blob, size, tag] = match;
    const text = intentText(tag);
    assert.equal(Number(size), Buffer.byteLength(text), "Release intent record is not canonical");
    tags.push(tag); blobs.push(blob); texts.push(text);
  }
  assert.equal(new Set(tags).size, tags.length, "Duplicate release intent record");
  // Blob sizes establish the exact boundaries in this batched read, so one
  // malformed file cannot borrow bytes from another to pass the comparison.
  const contents = await git(["show", "--format=", "--no-ext-diff", "--no-textconv", ...blobs], cwd);
  assert(contents === texts.join(""), "Release intent record content differs from its canonical filename and schema");
  return tags.sort(compareTags);
}
