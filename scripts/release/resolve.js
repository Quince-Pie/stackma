import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, validateMetadata, VersionMismatchError, versionFromTag } from "./package.js";
import { metadataAt, requireIncrease } from "./prepare.js";

export async function resolveRelease({ eventName, event, repository, workflowRef, mainCommit, tag, cwd = process.cwd() }) {
  assert.equal(workflowRef, "refs/heads/main", "Release must run from main");
  assert.match(mainCommit, /^[a-f0-9]{40}$/u);
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
  return { tag, commit, createTag: eventName === "pull_request" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await resolveRelease({
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
      repository: process.env.GITHUB_REPOSITORY, workflowRef: process.env.GITHUB_REF,
      mainCommit: process.env.GITHUB_SHA, tag: process.env.RELEASE_TAG,
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
