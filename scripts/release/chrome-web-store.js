import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromeVersion } from "../chrome-package.js";
import { sha256 } from "./package.js";

// Chrome Web Store API V2 (developer.chrome.com/docs/webstore/api; discovery
// chromewebstore.googleapis.com/$discovery/rest?version=v2). The store cannot
// create an item: the first package is uploaded in the Developer Dashboard.
export const storeOrigin = "https://chromewebstore.googleapis.com";
export const storeScope = "https://www.googleapis.com/auth/chromewebstore";
const stsUrl = "https://sts.googleapis.com/v1/token";
const credentialsOrigin = "https://iamcredentials.googleapis.com";
const activeStates = new Set(["PENDING_REVIEW", "STAGED"]);
const publishedStates = new Set(["PUBLISHED", "PUBLISHED_TO_TESTERS"]);
const knownStates = new Set([...activeStates, ...publishedStates, "REJECTED", "CANCELLED"]);

const boundedText = value => String(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 500);

/** A Google API refusal. Google's error message is kept; bodies are never echoed whole. */
export class GoogleApiError extends Error {
  constructor(operation, status, detail) {
    super(`${operation} returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

async function readJson(response, operation, limit = 1024 * 1024) {
  assert(response.body, `${operation} returned an empty body`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      assert(bytes <= limit, `${operation} response exceeds its size limit`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
  catch { throw new Error(`${operation} returned malformed JSON`); }
}

async function checked(response, operation) {
  if (response.ok) return readJson(response, operation);
  let detail = "";
  try {
    const body = await readJson(response, operation, 64 * 1024);
    // AIP-193 {error: {status, message}} or OAuth {error, error_description}.
    const error = body?.error;
    detail = typeof error === "object" && error ? [error.status, error.message].filter(Boolean).join(": ")
      : [error, body?.error_description].filter(Boolean).join(": ");
  } catch { detail = ""; }
  throw new GoogleApiError(operation, response.status, boundedText(detail));
}

const request = (fetchImpl, url, init, timeoutMs = 30_000) => fetchImpl(url, {
  ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
});

export const providerPattern = /^projects\/[1-9]\d{0,19}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/u;
export const serviceAccountPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/u;

/**
 * Exchange this GitHub Actions job's OIDC token for a short-lived access token
 * of the service account linked in the Developer Dashboard. No key or refresh
 * token exists to leak: cloud.google.com/iam/docs/
 * workload-identity-federation-with-deployment-pipelines, STS v1 token and
 * IAM Credentials generateAccessToken.
 */
export async function workloadIdentityToken({ provider, serviceAccount, requestUrl, requestToken, fetchImpl = fetch, lifetimeSeconds = 1_800 }) {
  assert.match(provider ?? "", providerPattern, "CWS_WORKLOAD_IDENTITY_PROVIDER must be projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER");
  assert.match(serviceAccount ?? "", serviceAccountPattern, "CWS_SERVICE_ACCOUNT must be a service account email");
  assert(requestUrl && requestToken, "GitHub did not provide an OIDC token; the job needs permissions: id-token: write");
  const tokenUrl = new URL(requestUrl);
  assert.equal(tokenUrl.protocol, "https:", "GitHub's OIDC endpoint must use HTTPS");
  // A provider without explicit audiences accepts its own resource name.
  tokenUrl.searchParams.set("audience", `https://iam.googleapis.com/${provider}`);
  const oidc = await checked(await request(fetchImpl, tokenUrl, {
    headers: { Authorization: `bearer ${requestToken}`, Accept: "application/json" },
  }), "GitHub OIDC token request");
  assert(typeof oidc?.value === "string" && oidc.value.split(".").length === 3, "GitHub returned no OIDC token");
  // STS rejects an Authorization header on this call.
  const federated = await checked(await request(fetchImpl, stsUrl, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${provider}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectToken: oidc.value,
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    }),
  }), "Google STS token exchange");
  assert(typeof federated?.access_token === "string" && federated.access_token.length > 0, "Google STS returned no access token");
  const url = new URL(`/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`, credentialsOrigin);
  const minted = await checked(await request(fetchImpl, url, {
    method: "POST",
    headers: { Authorization: `Bearer ${federated.access_token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ scope: [storeScope], lifetime: `${lifetimeSeconds}s` }),
  }), "IAM Credentials generateAccessToken");
  assert(typeof minted?.accessToken === "string" && minted.accessToken.length > 0, "IAM Credentials returned no access token");
  return minted.accessToken;
}

/** The narrow V2 protocol for one item. The token never leaves this origin. */
export class ChromeWebStore {
  #token;
  constructor({ publisherId, itemId, token, fetchImpl = fetch, pollMs = 5_000, uploadWaitMs = 5 * 60_000 }) {
    assert.match(publisherId ?? "", /^[A-Za-z0-9_-]{1,128}$/u, "CWS_PUBLISHER_ID must be the Developer Dashboard publisher ID");
    assert.match(itemId ?? "", /^[a-p]{32}$/u, "CWS_ITEM_ID must be the 32-letter Chrome Web Store item ID");
    assert(typeof token === "string" && token.length > 0, "Missing Chrome Web Store access token");
    this.itemId = itemId;
    this.name = `publishers/${publisherId}/items/${itemId}`;
    this.#token = token;
    this.fetchImpl = fetchImpl;
    this.pollMs = pollMs;
    this.uploadWaitMs = uploadWaitMs;
  }

  async #call(path, operation, { method = "GET", body, headers = {}, timeoutMs } = {}) {
    const url = new URL(path, storeOrigin);
    assert(url.origin === storeOrigin && /^\/(?:upload\/)?v2\/publishers\/[^/]+\/items\/[a-p]{32}:[A-Za-z]+$/u.test(url.pathname),
      "Unexpected Chrome Web Store API destination");
    const response = await request(this.fetchImpl, url, {
      method, body, headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json", ...headers },
    }, timeoutMs);
    return checked(response, `Chrome Web Store ${operation}`);
  }

  async fetchStatus() {
    const status = await this.#call(`/v2/${this.name}:fetchStatus`, "fetchStatus");
    assert.equal(status?.itemId, this.itemId, "Chrome Web Store returned a different item");
    return status;
  }

  // Raw-body media upload, as the V2 guide's curl -T example sends it.
  upload(bytes) {
    return this.#call(`/upload/v2/${this.name}:upload`, "upload", { method: "POST", body: bytes, timeoutMs: 180_000 });
  }

  publish(body) {
    return this.#call(`/v2/${this.name}:publish`, "publish", {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    });
  }

  cancelSubmission() {
    return this.#call(`/v2/${this.name}:cancelSubmission`, "cancelSubmission", {
      method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
    });
  }
}

export function compareChromeVersions(left, right) {
  const a = chromeVersion(left).split(".").map(Number);
  const b = chromeVersion(right).split(".").map(Number);
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Summarize a fetchStatus reply; unexpected shapes fail closed. */
export function storeState(status) {
  assert(status && typeof status === "object", "Chrome Web Store returned no item status");
  const revision = (value, field) => {
    if (value === undefined || value === null) return null;
    assert(typeof value.state === "string", `Chrome Web Store ${field} has no state`);
    // A state this controller does not know could be an active review.
    assert(knownStates.has(value.state), `Unsupported Chrome Web Store state ${value.state}; inspect the Developer Dashboard`);
    const channels = value.distributionChannels ?? [];
    assert(Array.isArray(channels), `Chrome Web Store ${field} has malformed channels`);
    const versions = channels.map(channel => chromeVersion(channel?.crxVersion));
    return { state: value.state, versions, channels: channels.map(channel => ({ version: channel.crxVersion, percent: channel.deployPercentage ?? null })) };
  };
  return {
    takenDown: status.takenDown === true,
    warned: status.warned === true,
    published: revision(status.publishedItemRevisionStatus, "published revision"),
    submitted: revision(status.submittedItemRevisionStatus, "submitted revision"),
    lastUpload: status.lastAsyncUploadState ?? null,
  };
}

export class PendingSubmissionError extends Error {
  constructor(version, pending) {
    super(`Chrome Web Store version ${pending} is still ${"in review or staged"}. Submitting ${version} now would require cancelling that submission; nothing was uploaded.\n\n` +
      `To keep ${pending}, wait for Google's decision, then rerun Publish release for v${version}.\n` +
      `To replace it deliberately, run Publish release with tag v${version} and chrome-supersede ${pending}. ` +
      "Each publisher can cancel a review up to six times per day.");
    this.name = "PendingSubmissionError";
    this.pending = pending;
  }
}

export class SubmissionOutcomeError extends Error {
  constructor(version, state) {
    super(state === "REJECTED"
      ? `The Chrome Web Store rejected version ${version}. Read the rejection email or the item's Status tab, fix the cause and release a new version.`
      : `The Chrome Web Store submission of ${version} was cancelled. Automation never resubmits a cancelled review; resolve it in the Developer Dashboard or release a new version.`);
    this.name = "SubmissionOutcomeError";
    this.state = state;
  }
}

/**
 * Submit the tested package, or reconcile an earlier attempt. One writer at a
 * time (the release workflow's queue); the store has no conditional writes, so
 * each write is preceded by a fresh status read and the caller's tag check.
 */
export async function submitChromeRelease({ store, context, zipPath, supersede = "", beforeWrite = async () => {}, report = () => {} }) {
  const version = chromeVersion(context.version);
  assert.equal(typeof supersede, "string");
  if (supersede !== "") chromeVersion(supersede);
  const bytes = await readFile(zipPath);
  assert.equal(sha256(bytes), context.chrome.sha256, "Chrome package differs from the tested ZIP");
  assert.equal(bytes.length, context.chrome.bytes);

  const settled = state => {
    if (state.takenDown) throw new Error("The Chrome Web Store took this item down for a policy violation; inspect the Developer Dashboard");
    if (state.warned) report({ notice: "The Chrome Web Store warned this item for a policy violation; inspect the Developer Dashboard" });
    if (state.published && publishedStates.has(state.published.state) && state.published.versions.includes(version)) {
      return { state: "published", channels: state.published.channels };
    }
    if (state.submitted?.versions.includes(version)) {
      if (state.submitted.state === "PENDING_REVIEW") return { state: "awaiting-review" };
      if (state.submitted.state === "STAGED") return { state: "staged" };
      if (publishedStates.has(state.submitted.state)) return { state: "published", channels: state.submitted.channels };
      throw new SubmissionOutcomeError(version, state.submitted.state);
    }
    // Any newer submission, even a rejected or cancelled one, means this
    // version was superseded; never go back to it, however the newer one ended.
    const known = [...(state.published?.versions ?? []), ...(state.submitted?.versions ?? [])];
    const newer = known.filter(other => compareChromeVersions(other, version) > 0);
    if (newer.length > 0) return { state: "superseded", newer: newer.sort(compareChromeVersions).at(-1) };
    return null;
  };

  let state = storeState(await store.fetchStatus());
  const done = settled(state);
  if (done) return done;
  if (state.submitted && activeStates.has(state.submitted.state)) {
    const pending = [...new Set(state.submitted.versions)];
    if (!(pending.length === 1 && pending[0] === supersede)) throw new PendingSubmissionError(version, pending.join(", ") || "(unknown)");
    await beforeWrite();
    report({ notice: `Cancelling Chrome Web Store review of ${supersede}, as explicitly requested` });
    await store.cancelSubmission();
    state = storeState(await store.fetchStatus());
    assert(!(state.submitted && activeStates.has(state.submitted.state)), "The superseded Chrome Web Store submission is still active; rerun to reconcile");
  } else if (supersede !== "") {
    report({ notice: `No Chrome Web Store submission of ${supersede} is active; nothing to supersede` });
  }

  await beforeWrite();
  report({ state: "uploading", version, sha256: context.chrome.sha256 });
  const upload = await store.upload(bytes);
  let uploadState = upload?.uploadState;
  if (uploadState === "IN_PROGRESS") {
    const deadline = Date.now() + store.uploadWaitMs;
    while (uploadState === "IN_PROGRESS") {
      assert(Date.now() < deadline, "Chrome Web Store package processing timed out; rerun to reconcile");
      await delay(store.pollMs);
      uploadState = storeState(await store.fetchStatus()).lastUpload;
    }
  } else if (uploadState === "SUCCEEDED") {
    assert.equal(upload.crxVersion, version, `Chrome Web Store read version ${upload.crxVersion ?? "(none)"} from the package, not ${version}`);
  }
  assert.equal(uploadState, "SUCCEEDED", "Chrome Web Store did not accept the package; inspect the item's Package tab");

  // Another writer may have acted during processing; recheck before submitting.
  state = storeState(await store.fetchStatus());
  const raced = settled(state);
  if (raced) return raced;
  assert(!(state.submitted && activeStates.has(state.submitted.state)), "Another Chrome Web Store submission became active; stop and inspect the Developer Dashboard");
  await beforeWrite();
  report({ state: "submitting", version });
  // Publish on approval, with the dashboard's visibility and rollout settings.
  const published = await store.publish({ publishType: "DEFAULT_PUBLISH" });
  for (const warning of published?.warningInfo?.warnings ?? []) {
    report({ warning: boundedText(`${warning.reason ?? "WARNING"}: ${warning.description ?? ""}`) });
  }
  // A delayed upload is only identified by the item's last upload state, so
  // require the store to have submitted exactly this version.
  const after = storeState(await store.fetchStatus());
  const submitted = [...(after.submitted?.versions ?? []), ...(after.published?.versions ?? [])];
  assert(submitted.length > 0, "The Chrome Web Store submission is not visible yet; rerun to reconcile");
  assert(submitted.includes(version), `The Chrome Web Store submitted ${submitted.join(", ")}, not ${version}; inspect the Developer Dashboard`);
  const result = settled(after);
  assert(result && result.state !== "superseded", "The Chrome Web Store submission is not in a reviewable state; inspect the Developer Dashboard");
  return { ...result, uploaded: true, submittedState: published?.state ?? null };
}
