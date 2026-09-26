import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, validateMetadata, VersionMismatchError, versionFromTag } from "./package.js";
import { metadataAt, requireIncrease } from "./prepare.js";
import { intentTagsAt } from "./intent.js";
import { GitHub } from "./github.js";
import { readRetirements } from "./retirement.js";
import { releaseChannelAt } from "./unlisted-policy.js";

export async function resolveRelease({ eventName, event, repository, workflowRef, mainCommit, tag, recoveryPull, retired, cwd = process.cwd() }) {
  assert.equal(workflowRef, "refs/heads/main", "Release must run from main");
  retired ??= await readRetirements();
  assert.match(mainCommit, /^[a-f0-9]{40}$/u);
  if (eventName === "pull_request_target") eventName = "pull_request";
  if (recoveryPull !== undefined) {
    assert.equal(eventName, "workflow_dispatch", "Merged-PR recovery requires an explicit dispatch");
    versionFromTag(tag);
    assert.equal(recoveryPull?.head?.ref, `release/${tag}`, "Recovery PR does not authorize the requested tag");
    // Reuse every merged-PR authority/source check. Dispatch alone does not
    // authorize inventing a missing tag or choosing a different source commit.
    eventName = "pull_request";
    event = { action: "closed", pull_request: recoveryPull };
  }
  const git = async args => (await run("git", args, { cwd, timeout: 30_000 })).stdout.trim();
  let commit;
  if (eventName === "pull_request") {
    const pr = event.pull_request;
    assert.equal(event.action, "closed");
    assert.equal(pr?.merged, true, "Only merging a release PR authorizes automatic release");
    assert.equal(pr.base?.ref, "main");
    assert.equal(pr.base?.repo?.full_name, repository);
    assert.equal(pr.head?.repo?.full_name, repository, "Fork PRs cannot initiate release");
    assert.match(pr.head.ref, /^release\/v\d+\.\d+\.\d+$/u);
    tag = pr.head.ref.slice("release/".length);
    versionFromTag(tag);
    const marker = /^<!-- stackma-release-pr:(v\d+\.\d+\.\d+):([a-f0-9]{40}):([a-f0-9]{40}) -->/u.exec(pr.body ?? "");
    assert(marker && marker[1] === tag, "Release PR preparation marker is missing or inconsistent");
    commit = pr.merge_commit_sha;
    assert.match(commit, /^[a-f0-9]{40}$/u);
    // A rebase/merge queue may append other commits after the version update.
    // The prepared base is the before-version authority, not the final parent.
    await git(["merge-base", "--is-ancestor", marker[2], commit]);
    const previous = (await metadataAt(marker[2], cwd)).map(text => JSON.parse(text));
    validateMetadata(`v${previous[0].version}`, ...previous);
    requireIncrease(previous[0].version, tag.slice(1));
  } else {
    assert.equal(eventName, "workflow_dispatch", "Unsupported release trigger");
    versionFromTag(tag);
    try {
      commit = await git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
    } catch {
      throw new Error(`Tag ${tag} is missing or invalid. Start a new version with Actions → Release (prepare-release.yml), then merge its PR. Publish release is for publication/recovery of prepared tags.`);
    }
  }
  await git(["merge-base", "--is-ancestor", commit, mainCommit]);
  assert(!retired.has(tag), "This release intent was explicitly retired; prepare a new version");
  try {
    validateMetadata(tag, ...(await metadataAt(commit, cwd)).map(text => JSON.parse(text)));
  } catch (error) {
    if (error instanceof VersionMismatchError) {
      error.message += `\n\n${tag} points to commit ${commit}. Creating a tag does not update version files.\n` +
        "Start with Actions → Release (prepare-release.yml), enter a new unused version, then merge the generated PR. The workflow creates the tag and GitHub Release after verification.\n" +
        "If the files disagree with each other, correct that inconsistency in a reviewed source commit before starting.\n" +
        "If this tag belongs to a published immutable release, its name cannot be reused even after deletion. Use a fresh version; do not move the existing tag.";
    }
    throw error;
  }
  const intents = await intentTagsAt(commit, cwd, { checkHistory: true });
  if (intents) assert.equal(intents.at(-1), tag, "Release must be the newest source-declared intent; do not remove or reorder admitted releases");
  assert.equal(await releaseChannelAt(tag, commit, cwd), "listed",
    "This source authorizes an unlisted release only. Use scripts/release/unlisted.js and its reviewed release PR; never submit it to the listed channel.");
  return { tag, commit, createTag: eventName === "pull_request" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    let recoveryPull;
    if (process.env.RECOVERY_PR) {
      assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
      assert.equal(process.env.GITHUB_REF, "refs/heads/main");
      assert.match(process.env.RECOVERY_PR, /^[1-9]\d*$/u, "Use a merged release PR number for recovery");
      assert(Number.isSafeInteger(Number(process.env.RECOVERY_PR)), "Recovery PR number exceeds the supported integer range");
      const github = new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
      recoveryPull = await github.mergedPull(Number(process.env.RECOVERY_PR));
    }
    // The trusted default-branch controller snapshot can precede the merged
    // source. Full checkout history includes the current protected main ref;
    // use it only for ancestry, never execute a PR head or replace merge identity.
    const mainCommit = process.env.GITHUB_EVENT_NAME === "pull_request_target"
      ? (await run("git", ["rev-parse", "refs/remotes/origin/main"], { timeout: 30_000 })).stdout.trim()
      : process.env.GITHUB_SHA;
    const result = await resolveRelease({
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
      repository: process.env.GITHUB_REPOSITORY, workflowRef: process.env.GITHUB_REF,
      mainCommit, tag: process.env.RELEASE_TAG,
      recoveryPull,
    });
    await appendFile(process.env.GITHUB_OUTPUT, `tag=${result.tag}\ncommit=${result.commit}\ncreate-tag=${result.createTag}\n`);
    console.log(`Release resolved: ${result.tag} at ${result.commit}`);
  } catch (error) {
    if (!(error instanceof VersionMismatchError)) throw error;
    // Escape workflow command data so even malformed committed metadata cannot
    // inject another command. Expected operator errors also get a run summary.
    const escaped = error.message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.error(`::error title=Release version mismatch::${escaped}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release stopped\n\n${error.message}\n`);
    process.exitCode = 1;
  }
}
