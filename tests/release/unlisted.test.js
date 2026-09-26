import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { parseArguments, checkUnlistedPublication, requireHostedVerification } from "../../scripts/release/unlisted.js";
import { releaseChannelAt } from "../../scripts/release/unlisted-policy.js";
import { bumpVersions, versionPaths } from "../../scripts/release/prepare.js";
import { run, sha256 } from "../../scripts/release/package.js";
import { temporary } from "./fixtures.js";

test("unlisted CLI needs an explicit canonical tag and merged PR", () => {
  assert.deepEqual(parseArguments(["--tag=v1.1.6", "--pull-request=8"]), { tag: "v1.1.6", pullNumber: 8 });
  for (const args of [[], ["--tag=v1.1.6"], ["--tag=v1.1.6", "--pull-request=0"],
    ["--tag=v1.1.6", "--pull-request=8", "--channel=listed"], ["--tag=v01.1.6", "--pull-request=8"]]) assert.throws(() => parseArguments(args));
});

test("hosted verification requires successful main-push CI for exactly the frozen commit", async () => {
  const commit = "a".repeat(40);
  const valid = { total_count: 1, workflow_runs: [{ head_sha: commit, head_branch: "main", event: "push", status: "completed", conclusion: "success" }] };
  const check = result => requireHostedVerification({ get: async path => {
    assert(path.includes(`head_sha=${commit}`)); return result;
  } }, commit);
  await check(valid);
  for (const change of [{ head_sha: "b".repeat(40) }, { head_branch: "release/v1.1.6" }, { event: "pull_request" },
    { status: "in_progress" }, { conclusion: "failure" }]) {
    const result = structuredClone(valid); Object.assign(result.workflow_runs[0], change);
    await assert.rejects(() => check(result));
  }
  await assert.rejects(() => check({ ...valid, total_count: 100 }));
  await assert.rejects(() => check({ total_count: 0, workflow_runs: [] }));
});

test("owner publication gate accepts an approved unlisted file without a public listing and rejects drift", async () => {
  const source = Buffer.from("reviewer source"), license = "WTFPL and CMU terms";
  const record = { id: "stackma@extensions.local", channel: "unlisted", version: "1.1.6", versionId: 6,
    signed: { sha256: "a".repeat(64), bytes: 42 }, source: { sha256: sha256(source) }, license: { apiSha256: sha256(license) } };
  const initial = { addon: { guid: record.id, is_disabled: false, status: "incomplete" },
    version: { id: 6, version: "1.1.6", channel: "unlisted", is_disabled: false,
      file: { status: "public", hash: `sha256:${record.signed.sha256}`, size: 42 }, license: { text: { "en-US": license } }, source: "https://addons.mozilla.org/source" } };
  const check = async state => checkUnlistedPublication(record, {
    fetchJson: async () => state.addon, version: async () => state.version, download: async () => state.wrongSource ? Buffer.from("changed") : source,
  });
  await check(initial);
  for (const change of [s => { s.addon.is_disabled = true; }, s => { s.addon.status = "rejected"; },
    s => { s.version.channel = "listed"; }, s => { s.version.is_disabled = true; }, s => { s.version.file.status = "unreviewed"; },
    s => { s.version.file.hash = `sha256:${"b".repeat(64)}`; }, s => { s.version.license.text["en-US"] = "different"; },
    s => { s.wrongSource = true; }, s => { s.version = null; }]) {
    const state = structuredClone(initial); change(state); await assert.rejects(() => check(state));
  }
});

test("unlisted authority is frozen in reviewed source and permits only a product version change", async t => {
  const cwd = await temporary(t);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = async (...args) => (await run("git", args, { cwd, env, timeout: 10_000 })).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await mkdir(`${cwd}/extension`); await mkdir(`${cwd}/release-exceptions`);
  const values = await Promise.all(versionPaths.map(async path => JSON.parse(await readFile(path, "utf8"))));
  values[0].version = values[1].version = values[2].version = values[2].packages[""].version = "1.1.5";
  for (let i = 0; i < versionPaths.length; i++) await writeFile(`${cwd}/${versionPaths[i]}`, JSON.stringify(values[i], null, 2) + "\n");
  await writeFile(`${cwd}/extension/code.js`, "original product\n");
  await git("add", "."); await git("commit", "--quiet", "-m", "test: Record prior product");
  const base = await git("rev-parse", "HEAD");
  assert.equal(await releaseChannelAt("v1.1.5", base, cwd), "listed");
  const contents = bumpVersions("v1.1.6", values.map(v => JSON.stringify(v)));
  for (let i = 0; i < versionPaths.length; i++) await writeFile(`${cwd}/${versionPaths[i]}`, contents[i]);
  const path = `${cwd}/release-exceptions/v1.1.6.json`;
  await writeFile(path, JSON.stringify({ schema: 1, tag: "v1.1.6", channel: "unlisted", base }, null, 2) + "\n");
  await git("add", "."); await git("commit", "--quiet", "-m", "test: Authorize unlisted version only");
  const frozen = await git("rev-parse", "HEAD");
  assert.equal(await releaseChannelAt("v1.1.6", frozen, cwd), "unlisted");
  await writeFile(path, "uncommitted tampering");
  assert.equal(await releaseChannelAt("v1.1.6", frozen, cwd), "unlisted");
  await git("add", "."); await git("commit", "--quiet", "-m", "test: Corrupt authority");
  const corrupted = await git("rev-parse", "HEAD");
  await assert.rejects(() => releaseChannelAt("v1.1.6", corrupted, cwd));
  await writeFile(path, JSON.stringify({ schema: 1, tag: "v1.1.6", channel: "unlisted", base }, null, 2) + "\n");
  await writeFile(`${cwd}/extension/code.js`, "unauthorized product change\n");
  await git("add", "."); await git("commit", "--quiet", "-m", "test: Change product behavior");
  const changed = await git("rev-parse", "HEAD");
  await assert.rejects(() => releaseChannelAt("v1.1.6", changed, cwd), /product code/u);
});
