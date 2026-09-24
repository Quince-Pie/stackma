import assert from "node:assert/strict";
import { GitHub } from "./github.js";
import { versionFromTag } from "./package.js";

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
    return response.json();
  }
}

export async function ensureTag(github, tag, commit, { create = false } = {}) {
  versionFromTag(tag);
  assert.match(commit, /^[a-f0-9]{40}$/u);
  const existing = await github.get(`git/ref/tags/${tag}`);
  if (!existing) {
    assert(create, `Tag ${tag} does not exist. Run Prepare release to create a release PR first.`);
    await github.post("git/refs", { ref: `refs/tags/${tag}`, sha: commit });
  }
  // A lost response is recovered on rerun; never repeat a write blindly.
  assert.equal(await github.commit(tag), commit, "Existing tag points to different source; never move a release tag");
}
