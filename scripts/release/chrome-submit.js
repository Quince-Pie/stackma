import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromeWebStore, PendingSubmissionError, SubmissionOutcomeError, submitChromeRelease, workloadIdentityToken } from "./chrome-web-store.js";
import { GitHub } from "./github.js";
import { versionFromTag } from "./package.js";
import { readRetirements } from "./retirement.js";

// Identifiers, not secrets. Credentials come from this job's OIDC token, or a
// short-lived CWS_ACCESS_TOKEN for an operator's local run.
export const settings = ["CWS_PUBLISHER_ID", "CWS_ITEM_ID", "CWS_WORKLOAD_IDENTITY_PROVIDER", "CWS_SERVICE_ACCOUNT"];
const command = text => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export async function runChromeSubmission({ env = process.env, directory = "artifacts/release-input", store, github, retired,
  log = console.log, warn = console.error, fetchImpl = fetch } = {}) {
  const context = JSON.parse(await readFile(`${directory}/context.json`, "utf8"));
  assert.equal(context.tag, env.RELEASE_TAG);
  assert.equal(context.commit, env.RELEASE_COMMIT);
  assert.equal(context.version, versionFromTag(context.tag));
  const setOutput = async value => { if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `state=${value}\n`); };
  const summarize = async text => { if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text); };
  if (!context.chrome) {
    log(`::notice title=No Chrome package::${context.tag} predates Chrome support; nothing was submitted to the Chrome Web Store.`);
    await setOutput("not-applicable");
    return { state: "not-applicable" };
  }
  const present = settings.filter(name => env[name]);
  if (!store && present.length === 0 && !env.CWS_ACCESS_TOKEN) {
    log("::notice title=Chrome Web Store not configured::Set the release-chrome-web-store variables (docs/chrome-web-store.md) to submit Chrome releases.");
    await summarize("## Chrome Web Store\n\nPublishing is not configured; the tested Chrome package was not submitted.\n");
    await setOutput("not-configured");
    return { state: "not-configured" };
  }
  retired ??= await readRetirements();
  assert(!retired.has(context.tag), "This release intent was explicitly retired; do not resume it");
  if (!store) {
    for (const name of ["CWS_PUBLISHER_ID", "CWS_ITEM_ID"]) assert(env[name], `Configure ${name} for Chrome Web Store publishing`);
    const token = env.CWS_ACCESS_TOKEN || await workloadIdentityToken({
      provider: env.CWS_WORKLOAD_IDENTITY_PROVIDER, serviceAccount: env.CWS_SERVICE_ACCOUNT,
      requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, fetchImpl,
    });
    // Never printed, but mask it in case a future change or tool echoes it.
    if (env.GITHUB_ACTIONS === "true") log(`::add-mask::${token}`);
    store = new ChromeWebStore({ publisherId: env.CWS_PUBLISHER_ID, itemId: env.CWS_ITEM_ID, token, fetchImpl });
  }
  github ??= new GitHub(env.GITHUB_REPOSITORY, env.GH_TOKEN);
  let result;
  const attention = [];
  const report = entry => {
    log(JSON.stringify(entry));
    // Policy warnings and publish warnings must be visible on a green run.
    const text = entry.warning ?? entry.notice;
    if (text) {
      attention.push(text);
      warn(`::warning title=Chrome Web Store::${command(text)}`);
    }
  };
  try {
    result = await submitChromeRelease({
      store, context, zipPath: `${directory}/chrome.zip`, supersede: env.CHROME_SUPERSEDE_PENDING ?? "",
      beforeWrite: async () => assert.equal(await github.commit(context.tag), context.commit, "Remote tag moved before Chrome Web Store submission"),
      report,
    });
  } catch (error) {
    if (!(error instanceof PendingSubmissionError) && !(error instanceof SubmissionOutcomeError)) throw error;
    const blocked = error instanceof PendingSubmissionError;
    warn(`::error title=${blocked ? "Another Chrome Web Store version is in review" : "Chrome Web Store submission needs attention"}::${command(error.message)}`);
    await summarize(`## Chrome Web Store: not submitted\n\n${error.message}\n${attention.map(text => `\n- ${text}`).join("")}\n`);
    const state = blocked ? "blocked-by-pending-review" : "needs-attention";
    await setOutput(state);
    return { state };
  }
  const { state } = result;
  const text = {
    "awaiting-review": `version ${context.version} is submitted and awaits review. It publishes automatically after approval, with the dashboard's visibility and rollout settings.`,
    published: `version ${context.version} is published.`,
    staged: `version ${context.version} passed review and is staged; publish it from the Developer Dashboard within 30 days.`,
    superseded: `the item already has newer version ${result.newer}; ${context.version} was not submitted.`,
  }[state];
  assert(text, `Unexpected Chrome Web Store result ${state}`);
  log(`::notice title=Chrome Web Store::${command(`Chrome Web Store ${text}`)}`);
  // Only a run that uploaded the tested ZIP may credit its digest; otherwise
  // the store's copy came from an earlier run or the Developer Dashboard.
  const origin = result.uploaded ? `This run submitted the tested package (SHA-256 \`${context.chrome.sha256}\`).`
    : "This run did not upload a package; the store's copy of this version came from an earlier run or the Developer Dashboard.";
  await summarize(`## Chrome Web Store\n\n${origin} Chrome Web Store ${text}\n${attention.map(entry => `\n- ${entry}`).join("")}\n`);
  await setOutput(state);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { state } = await runChromeSubmission();
  if (state === "blocked-by-pending-review" || state === "needs-attention") process.exitCode = 1;
}
