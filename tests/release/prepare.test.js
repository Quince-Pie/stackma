import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { bumpVersions, prepareRelease, requireIncrease, versionPaths, versionTree } from "../../scripts/release/prepare.js";
import { ensureTag, RepositoryGitHub } from "../../scripts/release/repository.js";
import { resolveRelease } from "../../scripts/release/resolve.js";
import { run } from "../../scripts/release/package.js";
import { temporary } from "./fixtures.js";

const initial = [
  { version: "1.1.0", permissions: ["storage"], browser_specific_settings: { gecko: { id: "stackma@extensions.local", strict_min_version: "156.0" } } },
  { name: "stackma", version: "1.1.0", private: true, scripts: { preversion: "must never run" }, devDependencies: { example: "1.1.0" } },
  { name: "stackma", version: "1.1.0", lockfileVersion: 3, packages: { "": { name: "stackma", version: "1.1.0" }, "node_modules/example": { version: "1.1.0", integrity: "original" } } },
];
const serialize = value => JSON.stringify(value, null, 2) + "\n";

async function fixture(t) {
  const cwd = await temporary(t);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = async (...args) => (await run("git", args, { cwd, env, timeout: 10_000 })).stdout.trimEnd();
  await mkdir(`${cwd}/extension`);
  await git("init", "--quiet", "--initial-branch=main");
  for (const [index, path] of versionPaths.entries()) await writeFile(`${cwd}/${path}`, serialize(initial[index]));
  await writeFile(`${cwd}/untouched.txt`, "original\n");
  await git("add", "."); await git("commit", "--quiet", "-m", "test: Initialize release fixture");
  const mainCommit = await git("rev-parse", "HEAD");
  // Independent tree oracle: edit exactly the four fields and let Git stage it.
  const expected = structuredClone(initial);
  expected[0].version = expected[1].version = expected[2].version = expected[2].packages[""].version = "1.1.1";
  for (const [index, path] of versionPaths.entries()) await writeFile(`${cwd}/${path}`, serialize(expected[index]));
  await git("add", ...versionPaths); const tree = await git("write-tree");
  await git("reset", "--hard", "HEAD");
  const refs = new Map(), commits = new Map(), pulls = [], calls = [];
  const state = { failAfter: null };
  const repository = "Quince-Pie/stackma";
  const github = {
    repository,
    async get(path) {
      if (path.startsWith("pulls?")) return structuredClone(pulls);
      if (path.startsWith("git/ref/")) {
        const sha = refs.get(path.slice("git/ref/".length));
        return sha ? { object: { type: "commit", sha } } : null;
      }
      if (path.startsWith("git/commits/")) return structuredClone(commits.get(path.slice("git/commits/".length)));
      assert.fail(`Unexpected GET ${path}`);
    },
    async post(path, body) {
      calls.push({ path, body });
      let result;
      if (path === "git/trees") {
        assert.equal(body.base_tree, await git("rev-parse", `${mainCommit}^{tree}`));
        assert.deepEqual(body.tree.map(entry => entry.path), versionPaths);
        assert.deepEqual(body.tree.map(entry => entry.content), expected.map(serialize));
        result = { sha: tree };
      } else if (path === "git/commits") {
        const sha = await git("commit-tree", body.tree, "-p", body.parents[0], "-m", body.message);
        result = { sha, message: body.message, tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })) };
        commits.set(sha, result);
      } else if (path === "git/refs") {
        const key = body.ref.slice("refs/".length);
        assert(!refs.has(key), "ref exists: create must fail");
        refs.set(key, body.sha); result = { object: { type: "commit", sha: body.sha } };
      } else if (path === "pulls") {
        assert.equal(pulls.length, 0);
        result = { ...body, number: 1, state: "open", head: { ref: body.head, sha: refs.get(`heads/${body.head}`), repo: { full_name: repository } }, base: { ref: body.base } };
        pulls.push(result);
      } else assert.fail(`Unexpected POST ${path}`);
      if (state.failAfter === path) { state.failAfter = null; throw new Error("lost response"); }
      return structuredClone(result);
    },
    async commit(tag) { return refs.get(`tags/${tag}`); },
  };
  const options = { github, tag: "v1.1.1", mainCommit, cwd };
  return { options, cwd, git, mainCommit, tree, refs, commits, pulls, calls, github, state };
}

test("version bump changes only four intended fields, with numeric ordering and Firefox bounds", () => {
  const actual = bumpVersions("v1.1.1", initial.map(serialize)).map(JSON.parse);
  const wanted = structuredClone(initial);
  wanted[0].version = wanted[1].version = wanted[2].version = wanted[2].packages[""].version = "1.1.1";
  assert.deepEqual(actual, wanted);
  for (const [before, after] of [["1.9.9", "1.10.0"], ["1.65535.65535", "2.0.0"], ["0.0.0", "0.0.1"]]) requireIncrease(before, after);
  for (const tag of ["v1.1.0", "v1.0.65535", "v01.1.1", "v1.1.1-beta", "v1000000000.0.0", "v1.1.1\n", "$(false)"]) {
    assert.throws(() => bumpVersions(tag, initial.map(serialize)));
  }
  const bad = structuredClone(initial); bad[2].packages[""].version = "0.0.0";
  assert.throws(() => bumpVersions("v1.1.1", bad.map(serialize)), /must agree/u);
});

test("isolated version tree preserves both staged and unstaged unrelated work", async t => {
  const f = await fixture(t);
  await writeFile(`${f.cwd}/untouched.txt`, "staged work\n"); await f.git("add", "untouched.txt");
  await writeFile(`${f.cwd}/untouched.txt`, "unstaged work\n");
  await writeFile(`${f.cwd}/extension/icon.png`, "user asset");
  const before = await f.git("status", "--porcelain=v1");
  const index = await f.git("write-tree");
  const actual = await versionTree("v1.1.1", f.mainCommit, f.cwd);
  assert.equal(actual.tree, f.tree);
  assert.equal(await f.git("write-tree"), index);
  assert.equal(await f.git("status", "--porcelain=v1"), before);
  assert.equal(await readFile(`${f.cwd}/untouched.txt`, "utf8"), "unstaged work\n");
  assert.equal(await readFile(`${f.cwd}/extension/icon.png`, "utf8"), "user asset");
});

test("prepare creates only a branch and PR; identical retry makes no writes", async t => {
  const f = await fixture(t), result = await prepareRelease(f.options);
  assert.equal(result.tree, f.tree);
  assert.equal(result.url, "https://github.com/Quince-Pie/stackma/pull/1");
  assert.equal(f.refs.size, 1); assert(f.refs.has("heads/release/v1.1.1"));
  const writes = f.calls.length;
  assert.deepEqual(await prepareRelease(f.options), result);
  assert.equal(f.calls.length, writes);
  assert.equal(await f.git("status", "--porcelain=v1"), "");
});

for (const failure of ["git/trees", "git/commits", "git/refs", "pulls"]) {
  test(`lost ${failure} response recovers without duplicate branches or PRs`, async t => {
    const f = await fixture(t); f.state.failAfter = failure;
    await assert.rejects(() => prepareRelease(f.options), /lost response/u);
    await prepareRelease(f.options);
    assert.equal(f.refs.size, 1); assert.equal(f.pulls.length, 1);
    assert.equal(f.calls.filter(call => call.path === "git/refs").length, 1);
    assert.equal(f.calls.filter(call => call.path === "pulls").length, 1);
  });
}

test("retry preserves the original PR when main advances", async t => {
  const f = await fixture(t), original = await prepareRelease(f.options);
  await writeFile(`${f.cwd}/untouched.txt`, "new main work\n");
  await f.git("add", "."); await f.git("commit", "--quiet", "-m", "test: Advance main");
  const writes = f.calls.length;
  const result = await prepareRelease({ ...f.options, mainCommit: await f.git("rev-parse", "HEAD") });
  assert.deepEqual(result, original); assert.equal(f.calls.length, writes);
});

test("Git's trailing message newline does not break branch recovery", async t => {
  const f = await fixture(t), original = await prepareRelease(f.options), writes = f.calls.length;
  f.commits.get(original.head).message += "\n";
  assert.deepEqual(await prepareRelease(f.options), original);
  assert.equal(f.calls.length, writes);
});

for (const conflict of ["message", "tree", "closed", "marker", "fork"]) {
  test(`${conflict} conflict is preserved, with no retry writes`, async t => {
    const f = await fixture(t), original = await prepareRelease(f.options), writes = f.calls.length;
    const commit = f.commits.get(original.head);
    if (conflict === "message") commit.message = "human work";
    if (conflict === "tree") commit.tree.sha = "f".repeat(40);
    if (conflict === "closed") f.pulls[0].state = "closed";
    if (conflict === "marker") f.pulls[0].body = "unrelated PR";
    if (conflict === "fork") f.pulls[0].head.repo.full_name = "someone/stackma";
    await assert.rejects(() => prepareRelease(f.options));
    assert.equal(f.calls.length, writes);
  });
}

test("a competing ref creation cannot be overwritten", async t => {
  const f = await fixture(t), post = f.github.post;
  f.github.post = async (path, body) => {
    if (path === "git/refs") f.refs.set("heads/release/v1.1.1", "f".repeat(40));
    return post(path, body);
  };
  await assert.rejects(() => prepareRelease(f.options), /ref exists/u);
  assert.equal(f.refs.get("heads/release/v1.1.1"), "f".repeat(40));
  assert.equal(f.pulls.length, 0);
});

for (const conflict of ["tree", "commit tree", "commit parent"]) {
  test(`unexpected GitHub ${conflict} cannot expose a release branch`, async t => {
    const f = await fixture(t), post = f.github.post;
    f.github.post = async (path, body) => {
      const result = await post(path, body);
      if (conflict === "tree" && path === "git/trees") result.sha = "f".repeat(40);
      if (conflict === "commit tree" && path === "git/commits") result.tree.sha = "f".repeat(40);
      if (conflict === "commit parent" && path === "git/commits") result.parents = [{ sha: "f".repeat(40) }];
      return result;
    };
    await assert.rejects(() => prepareRelease(f.options));
    assert.equal(f.refs.size, 0); assert.equal(f.pulls.length, 0);
  });
}

test("existing tags and duplicate PR history stop preparation before writes", async t => {
  const f = await fixture(t); f.refs.set("tags/v1.1.1", f.mainCommit);
  await assert.rejects(() => prepareRelease(f.options), /already has a tag/u);
  f.refs.clear(); f.pulls.push({ state: "open" }, { state: "open" });
  await assert.rejects(() => prepareRelease(f.options), /Ambiguous/u);
  assert.equal(f.calls.length, 0);
});

test("tag creation is recoverable and never changes an existing tag", async t => {
  const f = await fixture(t); f.state.failAfter = "git/refs";
  await assert.rejects(() => ensureTag(f.github, "v1.1.1", f.mainCommit, { create: true }), /lost response/u);
  await ensureTag(f.github, "v1.1.1", f.mainCommit, { create: true });
  assert.equal(f.calls.length, 1);
  await assert.rejects(() => ensureTag(f.github, "v1.1.1", "b".repeat(40), { create: true }), /never move/u);
  await assert.rejects(() => ensureTag(f.github, "v1.1.2", f.mainCommit), /Release \(prepare-release.yml\)/u);
  assert.equal(f.calls.length, 1);
});

test("write transport is create-only, bounded, redirect-free and does not expose service error bodies", async () => {
  const requests = [];
  const github = new RepositoryGitHub("Quince-Pie/stackma", "credential", async (url, options) => {
    requests.push({ url, options }); return Response.json({ sha: "a".repeat(40) }, { status: 201 });
  });
  await github.post("git/refs", { ref: "refs/tags/v1.1.1", sha: "a".repeat(40) });
  assert.equal(requests[0].options.method, "POST"); assert.equal(requests[0].options.redirect, "error");
  assert(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.headers["X-GitHub-Api-Version"], "2026-03-10");
  await assert.rejects(() => github.post("git/refs/heads/main", {}));
  for (const status of [401, 403, 409, 422, 500]) {
    const failing = new RepositoryGitHub("Quince-Pie/stackma", "credential", async () => new Response("private server body", { status }));
    await assert.rejects(() => failing.post("pulls", {}), error => error.message.includes(`HTTP ${status}`) && !error.message.includes("private"));
  }
});

test("manual release resolution explains missing tags and resolves annotated or lightweight tags", async t => {
  const f = await fixture(t);
  const options = { eventName: "workflow_dispatch", event: {}, repository: f.github.repository,
    workflowRef: "refs/heads/main", mainCommit: f.mainCommit, tag: "v1.1.1", cwd: f.cwd };
  await assert.rejects(() => resolveRelease(options), /Release \(prepare-release.yml\)/u);
  const prepared = await prepareRelease(f.options);
  await f.git("merge", "--ff-only", prepared.head);
  options.mainCommit = prepared.head;
  for (const annotated of [false, true]) {
    await f.git("tag", ...(annotated ? ["-a", "-m", "Fixture release"] : []), "v1.1.1");
    assert.deepEqual(await resolveRelease(options), { tag: "v1.1.1", commit: prepared.head, createTag: false });
    await f.git("tag", "-d", "v1.1.1");
  }
  await assert.rejects(() => resolveRelease({ ...options, workflowRef: "refs/heads/other" }), /main/u);
});

test("a tag on old version files exits with recovery instructions, no release output and no retagging", async t => {
  const f = await fixture(t);
  await f.git("tag", "v1.1.1");
  const eventPath = `${f.cwd}/event.json`, output = `${f.cwd}/output`, summary = `${f.cwd}/summary`;
  await writeFile(eventPath, "{}");
  await assert.rejects(() => run(process.execPath, [resolve("scripts/release/resolve.js")], {
    cwd: f.cwd, timeout: 10_000,
    env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: f.github.repository, GITHUB_REF: "refs/heads/main", GITHUB_SHA: f.mainCommit,
      RELEASE_TAG: "v1.1.1", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /::error title=Release version mismatch::/u);
    assert.match(error.stderr, /1\.1\.0/u);
    assert.match(error.stderr, /prepare-release.yml/u);
    assert.match(error.stderr, /cannot be reused even after deletion/u);
    assert(!error.stderr.includes("triggerUncaughtException"));
    assert(!error.stdout.includes("Release resolved"));
    return true;
  });
  assert.match(await readFile(summary, "utf8"), /Creating a tag does not update version files/u);
  await assert.rejects(() => readFile(output), { code: "ENOENT" });
  assert.equal(await f.git("rev-parse", "refs/tags/v1.1.1"), f.mainCommit);
});

test("a release commit outside the selected main history cannot be tagged or published", async t => {
  const f = await fixture(t), prepared = await prepareRelease(f.options);
  const event = { action: "closed", pull_request: { ...f.pulls[0], merged: true, merge_commit_sha: prepared.head,
    base: { ref: "main", repo: { full_name: f.github.repository } } } };
  await assert.rejects(() => resolveRelease({ eventName: "pull_request", event, repository: f.github.repository,
    workflowRef: "refs/heads/main", mainCommit: f.mainCommit, cwd: f.cwd }));
  assert(!f.refs.has("tags/v1.1.1"));
});

test("a merged group with later non-version commits retains the prepared version's before-state", async t => {
  const f = await fixture(t), prepared = await prepareRelease(f.options);
  await f.git("cherry-pick", prepared.head);
  await writeFile(`${f.cwd}/untouched.txt`, "another queued change\n");
  await f.git("add", "."); await f.git("commit", "--quiet", "-m", "test: Include later queued work");
  const mainCommit = await f.git("rev-parse", "HEAD");
  const event = { action: "closed", pull_request: { ...f.pulls[0], merged: true, merge_commit_sha: mainCommit,
    base: { ref: "main", repo: { full_name: f.github.repository } } } };
  const options = { eventName: "pull_request", event, repository: f.github.repository,
    workflowRef: "refs/heads/main", mainCommit, cwd: f.cwd };
  assert.deepEqual(await resolveRelease(options), { tag: "v1.1.1", commit: mainCommit, createTag: true });
  const bad = structuredClone(event);
  bad.pull_request.body = bad.pull_request.body.replace(f.mainCommit, mainCommit);
  await assert.rejects(() => resolveRelease({ ...options, event: bad }), /newer/u);
});

for (const mergeMode of ["merge", "squash", "rebase"]) {
  test(`${mergeMode} merge releases the merged main commit, with no pre-created tag`, async t => {
    const f = await fixture(t), prepared = await prepareRelease(f.options);
    if (mergeMode === "merge") await f.git("merge", "--no-ff", "-m", "Merge release PR", prepared.head);
    else if (mergeMode === "squash") {
      await f.git("merge", "--squash", prepared.head); await f.git("commit", "--quiet", "-m", "Squash release PR");
    } else await f.git("cherry-pick", prepared.head);
    const mainCommit = await f.git("rev-parse", "HEAD");
    const event = { action: "closed", pull_request: { ...f.pulls[0], merged: true, merge_commit_sha: mainCommit,
      base: { ref: "main", repo: { full_name: f.github.repository } } } };
    const options = { eventName: "pull_request", event, repository: f.github.repository, workflowRef: "refs/heads/main", mainCommit, cwd: f.cwd };
    assert.deepEqual(await resolveRelease(options), { tag: "v1.1.1", commit: mainCommit, createTag: true });
    for (const alter of [
      pr => { pr.merged = false; }, pr => { pr.head.repo.full_name = "fork/stackma"; },
      pr => { pr.head.ref = "feature"; }, pr => { pr.body = "ordinary PR"; },
      pr => { pr.head.ref = "release/v1.1.2"; }, pr => { pr.merge_commit_sha = f.mainCommit; },
    ]) {
      const bad = structuredClone(event); alter(bad.pull_request);
      await assert.rejects(() => resolveRelease({ ...options, event: bad }));
    }
  });
}
