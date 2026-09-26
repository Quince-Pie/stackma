import assert from "node:assert/strict";
import { GitHub } from "./github.js";
import { compareReleaseTags, versionFromTag } from "./package.js";

// Create-only operations. In particular, this client never PATCHes a ref,
// force-pushes, merges a PR, deletes a branch, or rewrites an existing PR.
export class RepositoryGitHub extends GitHub {
  async post(path, body) {
    assert(["git/trees", "git/commits", "git/refs", "pulls"].includes(path));
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new Error(`GitHub creation returned HTTP ${response.status}; rerun to reconcile its outcome`);
    }
    return this.json(response);
  }
}

export async function ensureTag(github, tag, commit, { create = false } = {}) {
  versionFromTag(tag);
  assert.match(commit, /^[a-f0-9]{40}$/u);
  const existing = await github.get(`git/ref/tags/${tag}`);
  if (!existing) {
    assert(create, `Tag ${tag} does not exist. Run Release (prepare-release.yml) to create a version PR first.`);
    await github.post("git/refs", { ref: `refs/tags/${tag}`, sha: commit });
  }
  // A lost response is recovered on rerun; never repeat a write blindly.
  assert.equal(await github.commit(tag), commit, "Existing tag points to different source; never move a release tag");
}

export class UnresolvedReleaseError extends Error {
  constructor(tags, message) {
    super(message ?? (`Earlier prepared release ${tags.join(", ")} has no observable AMO version. Its request may still be running after an interrupted run. ` +
      "Resume that release from main before starting a later submission. Do not assume a timeout cancelled Mozilla's work or remove its intent to bypass this gate."));
    this.name = "UnresolvedReleaseError";
    this.tags = tags;
  }
}

// Intent is committed with the version PR BEFORE tag creation. A tag POST may
// also time out ambiguously, so mutable/lagging tag observations cannot replace
// this frozen source inventory. A later source snapshot includes earlier intent;
// resuming that earlier source excludes future intent and remains possible.
export async function requireResolvedPriorReleases(github, tag, listedVersions, priorTags, retired = new Set()) {
  if (priorTags === undefined) throw new UnresolvedReleaseError([tag],
    "This legacy source has no reviewed release intent inventory. It can resume an existing AMO version, but cannot create a fresh one; prepare a new reviewed version with the current controller.");
  assert(Array.isArray(priorTags) && priorTags.length < 1000, "Invalid release intent inventory");
  assert(priorTags.every(prior => compareReleaseTags(prior, tag) < 0), "Release intent must precede its target");
  assert.equal(new Set(priorTags).size, priorTags.length, "Duplicate release intent");
  const known = new Set(listedVersions.map(version => `v${version.version}`));
  const unknown = priorTags.filter(other => !known.has(other) && !retired.has(other));
  if (unknown.length === 0) return;
  const published = new Set((await github.releases()).filter(release => !release.draft).map(release => release.tag_name));
  const unresolved = unknown.filter(other => !published.has(other)).sort(compareReleaseTags);
  if (unresolved.length > 0) throw new UnresolvedReleaseError(unresolved);
}
