import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, serializeManifest, validateMetadata, versionFromTag } from "./package.js";
import { RepositoryGitHub } from "./repository.js";

export const versionPaths = ["extension/manifest.json", "package.json", "package-lock.json"];
const shaPattern = /^[a-f0-9]{40}$/u;
const git = async (args, cwd, env = process.env) => (await run("git", args, {
  cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
})).stdout.trimEnd();

export function requireIncrease(previous, next) {
  const before = versionFromTag(`v${previous}`).split(".").map(Number);
  const after = versionFromTag(`v${next}`).split(".").map(Number);
  const position = after.findIndex((part, index) => part !== before[index]);
  assert(position !== -1 && after[position] > before[position], "Release version must be newer than the current main version");
}

export function bumpVersions(tag, texts) {
  const version = versionFromTag(tag);
  const [manifest, pkg, lock] = texts.map(text => JSON.parse(text));
  validateMetadata(`v${manifest.version}`, manifest, pkg, lock);
  requireIncrease(manifest.version, version);
  manifest.version = pkg.version = lock.version = lock.packages[""].version = version;
  return [serializeManifest(manifest), ...[pkg, lock].map(value => JSON.stringify(value, null, 2) + "\n")];
}

export async function metadataAt(commit, cwd) {
  assert.match(commit, shaPattern);
  return Promise.all(versionPaths.map(path => git(["show", `${commit}:${path}`], cwd)));
}

// Use an isolated index to calculate the entire expected tree with native Git.
// Neither the checkout nor its index is modified, even with local dirty files.
export async function versionTree(tag, base, cwd) {
  const contents = bumpVersions(tag, await metadataAt(base, cwd));
  const directory = await mkdtemp(join(tmpdir(), "stackma-version-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
  try {
    await git(["read-tree", base], cwd, env);
    const entries = [];
    for (const [index, path] of versionPaths.entries()) {
      const entry = await git(["ls-tree", base, "--", path], cwd);
      assert.match(entry, /^100644 blob /u, "Version inputs must be ordinary non-executable files");
      const file = join(directory, String(index));
      await writeFile(file, contents[index]);
      const sha = await git(["hash-object", "-w", "--", file], cwd);
      await git(["update-index", "--cacheinfo", "100644", sha, path], cwd, env);
      entries.push({ path, mode: "100644", type: "blob", content: contents[index] });
    }
    return { tree: await git(["write-tree"], cwd, env), baseTree: await git(["rev-parse", `${base}^{tree}`], cwd), entries };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareRelease({ github, tag, mainCommit, cwd = process.cwd() }) {
  const version = versionFromTag(tag);
  assert.match(mainCommit, shaPattern);
  assert.equal(await git(["rev-parse", "HEAD"], cwd), mainCommit, "Preparation checkout must match the selected main revision");
  const current = (await metadataAt(mainCommit, cwd)).map(text => JSON.parse(text));
  validateMetadata(`v${current[0].version}`, ...current);
  requireIncrease(current[0].version, version);
  assert(!await github.get(`git/ref/tags/${tag}`),
    "Version already has a tag. If its source versions match, use Publish release to resume it. Otherwise start Release with a new unused version. Published immutable tag names cannot be reused, even after deletion.");
  const branch = `release/${tag}`;
  const owner = github.repository.split("/")[0];
  const pulls = await github.get(`pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=main&per_page=100`);
  assert(Array.isArray(pulls) && pulls.length <= 1, "Ambiguous release PR history; inspect it before retrying");
  let pull = pulls[0];
  assert(!pull || pull.state === "open", "Release PR is already closed; reopen it explicitly or resume its Release run after merge");
  const ref = await github.get(`git/ref/heads/${branch}`);
  assert(!pull || ref, "Release PR branch was deleted; restore it explicitly");
  let head = ref?.object.sha;
  let base = mainCommit;
  let existing;
  const message = `release: Prepare ${tag}\n\nKeep the Firefox and npm versions aligned for the reviewed release.`;
  if (ref) {
    assert.equal(ref.object.type, "commit");
    assert.match(head, shaPattern);
    existing = await github.get(`git/commits/${head}`);
    assert(existing?.parents.length === 1 && existing.message?.trimEnd() === message,
      "Release branch was edited or belongs to other work; never overwrite it");
    base = existing.parents[0].sha;
    assert.match(base, shaPattern);
    await git(["merge-base", "--is-ancestor", base, mainCommit], cwd);
  }
  const expected = await versionTree(tag, base, cwd);
  if (existing) {
    assert.equal(existing.tree.sha, expected.tree, "Release branch contents conflict; never overwrite them");
  } else {
    const tree = await github.post("git/trees", { base_tree: expected.baseTree, tree: expected.entries });
    assert.equal(tree.sha, expected.tree, "GitHub tree differs from the locally verified version update");
    const commit = await github.post("git/commits", { message, tree: expected.tree, parents: [base] });
    assert.match(commit.sha, shaPattern);
    assert.equal(commit.tree.sha, expected.tree);
    assert.deepEqual(commit.parents.map(parent => parent.sha), [base]);
    head = commit.sha;
    // Server-side create-if-absent: a competing branch creation fails, not overwrites.
    await github.post("git/refs", { ref: `refs/heads/${branch}`, sha: head });
  }
  const marker = `<!-- stackma-release-pr:${tag}:${base}:${expected.tree} -->`;
  assert.equal((await github.get(`git/ref/heads/${branch}`))?.object.sha, head, "Release branch changed during preparation");
  if (!pull) {
    pull = await github.post("pulls", {
      head: branch, base: "main", title: `release: Prepare ${tag}`,
      body: `${marker}\n\nPrepare Stackma ${version} for the existing Mozilla listing. This updates only the manifest, package version, and root lockfile versions.\n\nApprove the bot-triggered CI run if GitHub requests it, review the changes, and merge this PR. Merging starts Publish release: it verifies the exact merged source, creates ${tag}, submits or resumes Mozilla signing, and publishes the verified package after approval. Do not create a tag or GitHub Release manually.\n\nIf signing needs more review time, rerun the original Publish release run after Mozilla approval. See [the release guide](https://github.com/${github.repository}/blob/main/docs/releases.md).\n`,
    });
  }
  assert.equal(pull.state, "open");
  assert.equal(pull.head?.sha, head, "Release PR head changed");
  assert.equal(pull.head?.repo?.full_name, github.repository);
  assert.equal(pull.head?.ref, branch);
  assert.equal(pull.base?.ref, "main");
  assert(pull.body?.startsWith(marker), "Existing PR belongs to other work; never rewrite it");
  assert(Number.isSafeInteger(pull.number) && pull.number > 0);
  return { tag, base, head, tree: expected.tree, number: pull.number,
    url: `https://github.com/${github.repository}/pull/${pull.number}` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Run Release (prepare-release.yml) from main");
  const result = await prepareRelease({
    github: new RepositoryGitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
    tag: process.env.RELEASE_TAG, mainCommit: process.env.GITHUB_SHA,
  });
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Release PR ready: [${result.tag} — #${result.number}](${result.url}).\n\nApprove CI if requested, then review and merge. Publish release runs automatically after merge; it creates the tag and GitHub Release. Do not create either manually.\n`);
  console.log(`Release PR ready: ${result.url}`);
}
