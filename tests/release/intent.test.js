import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { intentPath, intentTagsAt, intentText } from "../../scripts/release/intent.js";
import { requireResolvedPriorReleases, UnresolvedReleaseError } from "../../scripts/release/repository.js";
import { run } from "../../scripts/release/package.js";
import { temporary } from "./fixtures.js";

const record = tag => JSON.stringify({ schema: 1, tag }, null, 2) + "\n";

async function fixture(t) {
  const cwd = await temporary(t);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = async (...args) => (await run("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd, env, timeout: 10_000 })).stdout.trimEnd();
  await git("init", "--quiet", "--initial-branch=main");
  await writeFile(`${cwd}/product.txt`, "unchanged product\n");
  await git("add", "."); await git("commit", "--quiet", "-m", "test: Establish pre-inventory source");
  const before = await git("rev-parse", "HEAD");
  const add = async tag => {
    await mkdir(`${cwd}/release-intents`, { recursive: true });
    await writeFile(`${cwd}/release-intents/${tag}.json`, record(tag));
    await git("add", "."); await git("commit", "--quiet", "-m", `test: Record ${tag} intent`);
    return git("rev-parse", "HEAD");
  };
  const commit = async () => { await git("add", "."); await git("commit", "--quiet", "-m", "test: Change intent fixture"); return git("rev-parse", "HEAD"); };
  return { cwd, git, before, add, commit, env };
}

test("intent records have exact stable filenames and canonical schema bytes", () => {
  assert.equal(intentPath("v1.2.3"), "release-intents/v1.2.3.json");
  assert.equal(intentText("v1.2.3"), '{\n  "schema": 1,\n  "tag": "v1.2.3"\n}\n');
  for (const tag of ["v01.2.3", "v1.2.3-beta", "v1000000000.0.0", "../v1.2.3", "v1.2.3\n"]) {
    assert.throws(() => intentPath(tag)); assert.throws(() => intentText(tag));
  }
});

test("source snapshots retain their own intent inventory despite later files and missing remote tags", async t => {
  const f = await fixture(t);
  assert.equal(await intentTagsAt(f.before, f.cwd, { checkHistory: true }), null);
  const a = await f.add("v1.1.4"), b = await f.add("v1.1.5");
  await writeFile(`${f.cwd}/release-intents/v9.0.0.json`, record("v9.0.0"));
  assert.deepEqual(await intentTagsAt(a, f.cwd, { checkHistory: true }), ["v1.1.4"]);
  assert.deepEqual(await intentTagsAt(b, f.cwd, { checkHistory: true }), ["v1.1.4", "v1.1.5"]);
  const github = { async get() { assert.fail("Remote tag visibility cannot establish source intent"); }, async releases() { return []; } };
  const priorA = (await intentTagsAt(a, f.cwd)).filter(tag => tag !== "v1.1.4");
  const priorB = (await intentTagsAt(b, f.cwd)).filter(tag => tag !== "v1.1.5");
  // A's tag POST can still be unobservable after timeout. B nevertheless
  // knows A was admitted by reviewed source and cannot submit.
  await assert.rejects(() => requireResolvedPriorReleases(github, "v1.1.5", [], priorB), UnresolvedReleaseError);
  // A can retry without waiting for future B: its frozen source has no B.
  await requireResolvedPriorReleases(github, "v1.1.4", [], priorA);
  await requireResolvedPriorReleases(github, "v1.1.5", [{ version: "1.1.4" }], priorB);
  assert.equal(await readFile(`${f.cwd}/product.txt`, "utf8"), "unchanged product\n");
});

test("inventory sorts numeric versions and rejects malformed records and file modes", async t => {
  const ordered = await fixture(t);
  await ordered.add("v1.1.10"); const head = await ordered.add("v1.1.9");
  assert.deepEqual(await intentTagsAt(head, ordered.cwd), ["v1.1.9", "v1.1.10"]);
  for (const change of ["schema", "tag", "format", "executable", "symlink", "nested"]) {
    const f = await fixture(t); await f.add("v1.1.4");
    const path = `${f.cwd}/release-intents/v1.1.4.json`;
    if (change === "schema") await writeFile(path, record("v1.1.4").replace('"schema": 1', '"schema": 2'));
    if (change === "tag") await writeFile(path, record("v1.1.5"));
    if (change === "format") await writeFile(path, '{"schema":1,"tag":"v1.1.4"}\n');
    if (change === "executable") await chmod(path, 0o755);
    if (change === "symlink") {
      await f.git("rm", "release-intents/v1.1.4.json");
      await mkdir(`${f.cwd}/release-intents`, { recursive: true }); await symlink("../product.txt", path);
    }
    if (change === "nested") { await mkdir(`${f.cwd}/release-intents/nested`); await writeFile(`${f.cwd}/release-intents/nested/v1.1.5.json`, record("v1.1.5")); }
    const revision = await f.commit();
    await assert.rejects(() => intentTagsAt(revision, f.cwd), /intent/iu);
  }
});

test("history rejects edited, deleted, renamed, and restored intent records", async t => {
  for (const change of ["edit-and-restore", "delete-all", "rename-outside"]) {
    const f = await fixture(t); const original = await f.add("v1.1.4");
    if (change === "edit-and-restore") {
      await writeFile(`${f.cwd}/release-intents/v1.1.4.json`, record("v1.1.5")); await f.commit();
      await writeFile(`${f.cwd}/release-intents/v1.1.4.json`, record("v1.1.4"));
    } else if (change === "delete-all") await f.git("rm", "release-intents/v1.1.4.json");
    else await f.git("mv", "release-intents/v1.1.4.json", "moved.json");
    const revision = await f.commit();
    await assert.rejects(() => intentTagsAt(revision, f.cwd, { checkHistory: true }), /intent history/iu);
    assert.deepEqual(await intentTagsAt(original, f.cwd, { checkHistory: true }), ["v1.1.4"]);
  }
});

test("first-parent merge validation accepts additions and detects deleted records", async t => {
  for (const deletion of [false, true]) {
    const f = await fixture(t); await f.add("v1.1.4");
    await f.git("switch", "--quiet", "-c", "release-branch");
    if (deletion) { await f.git("rm", "release-intents/v1.1.4.json"); await f.commit(); }
    else await f.add("v1.1.5");
    await f.git("switch", "--quiet", "main");
    await f.git("merge", "--quiet", "--no-ff", "-m", "Merge reviewed release source", "release-branch");
    const revision = await f.git("rev-parse", "HEAD");
    if (deletion) await assert.rejects(() => intentTagsAt(revision, f.cwd, { checkHistory: true }), /intent history/iu);
    else assert.deepEqual(await intentTagsAt(revision, f.cwd, { checkHistory: true }), ["v1.1.4", "v1.1.5"]);
  }
});

test("shallow source can be staged but cannot prove protected intent history", async t => {
  const f = await fixture(t), revision = await f.add("v1.1.4"), shallow = await temporary(t);
  await run("git", ["clone", "--quiet", "--depth=1", `file://${f.cwd}`, shallow], { env: f.env, timeout: 10_000 });
  assert.deepEqual(await intentTagsAt(revision, shallow), ["v1.1.4"]);
  await assert.rejects(() => intentTagsAt(revision, shallow, { checkHistory: true }), /complete checkout/u);
});

test("intent history is bounded and legacy source cannot authorize fresh creation", async t => {
  const f = await fixture(t);
  await mkdir(`${f.cwd}/release-intents`);
  await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(`${f.cwd}/release-intents/v1.0.${i}.json`, record(`v1.0.${i}`))));
  const revision = await f.commit();
  await assert.rejects(() => intentTagsAt(revision, f.cwd), /1000/u);
  const github = { async releases() { return []; } };
  await assert.rejects(() => requireResolvedPriorReleases(github, "v1.1.4", []), UnresolvedReleaseError);
});

test("published migration history resolves prior intent but draft history does not", async () => {
  const github = { async releases() { return [{ tag_name: "v1.1.4", draft: false }]; } };
  await requireResolvedPriorReleases(github, "v1.1.5", [], ["v1.1.4"]);
  github.releases = async () => [{ tag_name: "v1.1.4", draft: true }];
  await assert.rejects(() => requireResolvedPriorReleases(github, "v1.1.5", [], ["v1.1.4"]), UnresolvedReleaseError);
});
