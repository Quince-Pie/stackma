import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PendingReviewError, ReleaseClient, signRelease } from "./amo.js";
import { artifactNames, releaseBrand, versionFromTag } from "./package.js";
import { GitHub } from "./github.js";
import { requireResolvedPriorReleases, UnresolvedReleaseError } from "./repository.js";
import { readRetirements } from "./retirement.js";

// Stop waiting for Mozilla after this and report a resumable pending state.
// It leaves ReleaseClient's 20-minute hard deadline for post-approval work.
export const approvalWaitMs = 15 * 60_000;

const command = text => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export async function runSigning({ env = process.env, directory = "artifacts/release-input", signedDirectory = "artifacts/release-signed",
  client, github, retired, log = console.log, warn = console.error, wait = approvalWaitMs, sign = signRelease } = {}) {
  retired ??= await readRetirements();
  const context = JSON.parse(await readFile(`${directory}/context.json`, "utf8"));
  assert.equal(context.tag, env.RELEASE_TAG);
  assert.equal(context.commit, env.RELEASE_COMMIT);
  assert.equal(context.version, versionFromTag(context.tag));
  assert.equal(context.id, "stackma@extensions.local");
  assert.equal(context.channel, "listed");
  const { displayName } = releaseBrand(context);
  assert(!retired.has(context.tag), "This release intent was explicitly retired; do not resume it");
  const supersede = env.SUPERSEDE_PENDING ?? "";
  if (supersede !== "") {
    assert.match(supersede, /^\d+\.\d+\.\d+$/u, "supersede must be the AMO version awaiting review, for example 1.1.4");
    assert.notEqual(versionFromTag(`v${supersede}`), context.version, "A version cannot supersede itself");
  }
  if (!client) {
    const apiKey = env.AMO_JWT_ISSUER;
    const apiSecret = env.AMO_JWT_SECRET;
    assert(apiKey && apiSecret, "Configure AMO_JWT_ISSUER and AMO_JWT_SECRET in the release-signing environment");
    client = new ReleaseClient({ apiKey, apiSecret });
  }
  github ??= new GitHub(env.GITHUB_REPOSITORY, env.GH_TOKEN);
  const setOutput = async value => { if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `state=${value}\n`); };
  const summarize = async text => { if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text); };
  await mkdir(signedDirectory, { recursive: true });
  let result;
  try {
    result = await sign({
      client, context, directory, output: `${signedDirectory}/${artifactNames(context).xpi}`, supersede, approvalWaitMs: wait,
      report: state => log(JSON.stringify(state)),
      beforeWrite: async () => assert.equal(await github.commit(context.tag), context.commit, "Remote tag moved before Mozilla submission"),
      checkPriorReleases: versions => requireResolvedPriorReleases(github, context.tag, versions, context.priorReleases, retired),
    });
  } catch (error) {
    if (!(error instanceof PendingReviewError) && !(error instanceof UnresolvedReleaseError)) throw error;
    warn(`::error title=${error instanceof PendingReviewError ? "Another version awaits Mozilla review" : "Earlier release outcome is unresolved"}::${command(error.message)}`);
    await summarize(`## Release not submitted\n\n${error.message}\n`);
    return error instanceof PendingReviewError
      ? { state: "blocked-by-pending-review", pending: error.pending }
      : { state: "blocked-by-unresolved-release", tags: error.tags };
  }
  const { state, ...record } = result;
  if (state === "awaiting-review") {
    await setOutput(state);
    log(`::notice title=Awaiting Mozilla review::${command(`${displayName} ${context.version} is submitted and awaits Mozilla review. The GitHub release follows approval.`)}`);
    await summarize(`## Awaiting Mozilla review\n\n${displayName} ${context.version} is submitted to the listed channel as AMO version ${record.versionId}. ` +
      `Its package matches the tested XPI and its source is attached. Mozilla has not approved it yet (file status: ${record.fileStatus}).\n\n` +
      `Nothing else is required. **Resume approved releases** checks every 6 hours and runs **Publish release** for ${context.tag} after approval. ` +
      `To publish sooner after approval, run **Publish release** with tag ${context.tag}.\n`);
    return { state };
  }
  assert.equal(state, "approved-and-signed");
  await writeFile(`${signedDirectory}/signing.json`, JSON.stringify({ ...context, ...record }, null, 2) + "\n");
  await setOutput(state);
  return { state };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { state } = await runSigning();
  if (state === "blocked-by-pending-review" || state === "blocked-by-unresolved-release") process.exitCode = 1;
}
