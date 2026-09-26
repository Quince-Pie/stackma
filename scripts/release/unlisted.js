import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseClient, signRelease } from "./amo.js";
import { publishRelease } from "./github.js";
import { RepositoryGitHub, ensureTag } from "./repository.js";
import { digestFile, run, sha256, versionFromTag } from "./package.js";
import { releaseChannelAt } from "./unlisted-policy.js";
import { readRetirements } from "./retirement.js";

const controller = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = name => join(controller, "scripts", name);

export function parseArguments(args) {
  const values = {};
  for (const arg of args) {
    const match = /^--(tag|pull-request)=(.+)$/u.exec(arg);
    assert(match && !Object.hasOwn(values, match[1]), "Use --tag=vVERSION --pull-request=NUMBER exactly once");
    values[match[1]] = match[2];
  }
  versionFromTag(values.tag);
  assert.match(values["pull-request"] ?? "", /^[1-9]\d*$/u, "A merged release PR is required");
  const pullNumber = Number(values["pull-request"]);
  assert(Number.isSafeInteger(pullNumber));
  return { tag: values.tag, pullNumber };
}

export async function checkUnlistedPublication(record, client) {
  assert.equal(record.id, "stackma@extensions.local");
  assert.equal(record.channel, "unlisted");
  const addon = await client.fetchJson(new URL(`https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(record.id)}/`));
  assert.equal(addon.guid, record.id);
  assert.equal(addon.is_disabled, false, "Mozilla disabled the add-on");
  assert(["public", "nominated", "incomplete"].includes(addon.status), "Unsupported Mozilla listing state");
  const version = await client.version(record.id, record.version);
  assert(version, "Mozilla version disappeared before publication");
  assert.equal(version.id, record.versionId);
  assert.equal(version.version, record.version);
  assert.equal(version.channel, "unlisted");
  assert.equal(version.is_disabled, false, "Mozilla version is disabled");
  assert.equal(version.file?.status, "public", "Unlisted version is not approved and signed");
  assert.equal(version.file.hash, `sha256:${record.signed.sha256}`, "Mozilla file changed after verification");
  assert.equal(version.file.size, record.signed.bytes);
  assert.equal(typeof version.license?.text?.["en-US"], "string");
  assert.equal(sha256(version.license.text["en-US"]), record.license.apiSha256, "Mozilla license changed after verification");
  assert.equal(typeof version.source, "string");
  assert.equal(sha256(await client.download(version.source)), record.source.sha256, "Mozilla source changed after verification");
}

export async function requireHostedVerification(github, commit) {
  const result = await github.get(`actions/workflows/ci.yml/runs?event=push&head_sha=${commit}&per_page=100`);
  assert(Array.isArray(result?.workflow_runs) && result.total_count < 100, "Cannot establish hosted verification history");
  const runs = result.workflow_runs.filter(r => r.head_sha === commit && r.head_branch === "main" && r.event === "push");
  assert(runs.length > 0 && runs.every(r => r.status === "completed" && r.conclusion === "success"),
    "Wait for successful hosted CI on the exact merged main commit before signing");
}

async function requireIdlePublisher(github) {
  const result = await github.get("actions/workflows/release.yml/runs?per_page=100");
  assert(Array.isArray(result?.workflow_runs) && result.workflow_runs.length < 100,
    "Publication history exceeds the manual-path bound; inspect it before continuing");
  assert(result.workflow_runs.every(r => r.status === "completed"), "Another hosted publisher is active; let it finish before this one-off release");
}

export async function runUnlisted({ tag, pullNumber, env = process.env }) {
  const git = async args => (await run("git", args, { timeout: 30_000 })).stdout.trim();
  const commit = await git(["rev-parse", "HEAD"]);
  assert.equal(await releaseChannelAt(tag, commit), "unlisted", "Frozen source does not authorize unlisted distribution");
  assert(!(await readRetirements()).has(tag), "This release intent was retired");
  const common = resolve(await git(["rev-parse", "--git-common-dir"]));
  const lockPath = join(common, "stackma-unlisted.lock");
  const lock = await open(lockPath, "wx"); // All local worktrees share this lock.
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, tag, commit }) + "\n");
    const repository = env.GITHUB_REPOSITORY ?? "Quince-Pie/stackma";
    assert.equal(repository, "Quince-Pie/stackma");
    const token = env.GH_TOKEN || env.GITHUB_TOKEN;
    const github = new RepositoryGitHub(repository, token);
    await run("gh", ["--version"], { env, timeout: 10_000 });
    // gh reads credentials from its child environment, never command arguments.
    github.cli = args => run("gh", [...args, "--repo", repository], {
      env: { ...env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    const pull = await github.mergedPull(pullNumber);
    assert.equal(pull.merge_commit_sha, commit, "Checkout is not the integrated release PR");
    assert.equal(pull.base?.ref, "main");
    assert.equal(pull.base?.repo?.full_name, repository);
    assert.equal(pull.head?.repo?.full_name, repository);
    assert.equal(pull.head?.ref, `codex/unlisted-${tag}`);
    await requireHostedVerification(github, commit);
    await requireIdlePublisher(github);
    const childEnv = { ...env, RELEASE_TAG: tag, RELEASE_COMMIT: commit };
    await run(process.execPath, [script("release/stage.js")], { env: childEnv, timeout: 60_000 });
    const directory = "artifacts/release-input", signedDirectory = "artifacts/release-signed";
    const context = JSON.parse(await readFile(`${directory}/context.json`, "utf8"));
    assert.equal(context.channel, "unlisted");
    assert.equal(context.commit, commit); assert.equal(context.tag, tag);
    assert.deepEqual(await digestFile(`${directory}/unsigned.xpi`), context.unsigned);
    assert.deepEqual(await digestFile(`${directory}/source.zip`), context.source);
    await mkdir(signedDirectory, { recursive: true });
    await ensureTag(github, tag, commit, { create: true });
    const client = new ReleaseClient({ apiKey: env.AMO_JWT_ISSUER ?? env.JWT_ISSUER,
      apiSecret: env.AMO_JWT_SECRET ?? env.JWT_SECRET });
    const result = await signRelease({ client, context, directory, output: `${signedDirectory}/stackma-${context.version}.xpi`,
      approvalWaitMs: 15 * 60_000, report: state => console.log(JSON.stringify(state)),
      beforeWrite: async () => {
        assert.equal(await github.commit(tag), commit, "Remote tag changed before Mozilla write");
        await requireIdlePublisher(github);
      },
    });
    await writeFile("artifacts/unlisted-status.json", JSON.stringify({ tag, commit, ...result }, null, 2) + "\n");
    if (result.state === "awaiting-review") {
      console.log("Unlisted submission awaits Mozilla. Rerun this same command from this frozen source after approval; no GitHub release was published.");
      return result;
    }
    assert.equal(result.state, "approved-and-signed");
    const { state: _state, ...record } = result;
    await writeFile(`${signedDirectory}/signing.json`, JSON.stringify({ ...context, ...record }, null, 2) + "\n");
    await run(process.execPath, [script("package-test.js"), "--signed", `--source-root=${process.cwd()}`,
      `--xpi=${signedDirectory}/stackma-${context.version}.xpi`, "--output=artifacts/release-verification.json"], { env, timeout: 180_000 });
    await run(process.execPath, [script("release/assemble.js")], { env, timeout: 30_000 });
    await requireIdlePublisher(github);
    const release = JSON.parse(await readFile(`${signedDirectory}/release.json`, "utf8"));
    const published = await publishRelease({ github, record: release, directory: signedDirectory, notesPath: "artifacts/release-notes.md",
      amoCheck: value => checkUnlistedPublication(value, client) });
    await writeFile("artifacts/release-publication.json", JSON.stringify(published, null, 2) + "\n");
    console.log(`Verified immutable unlisted release: ${published.url}`);
    return published;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runUnlisted(parseArguments(process.argv.slice(2)));
}
