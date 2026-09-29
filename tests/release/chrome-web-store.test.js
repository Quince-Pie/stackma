import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChromeWebStore, GoogleApiError, PendingSubmissionError, SubmissionOutcomeError, compareChromeVersions,
  storeState, submitChromeRelease, workloadIdentityToken,
} from "../../scripts/release/chrome-web-store.js";
import { runChromeSubmission } from "../../scripts/release/chrome-submit.js";
import { sha256 } from "../../scripts/release/package.js";

const provider = "projects/123456789012/locations/global/workloadIdentityPools/tab-gantry/providers/github";
const serviceAccount = "chrome-publisher@example-project.iam.gserviceaccount.com";
const itemId = "abcdefghijklmnopabcdefghijklmnop";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function recorder(respond) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const request = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body, redirect: init.redirect };
    requests.push(request);
    return respond(request, requests.length);
  };
  return { requests, fetchImpl };
}

test("workload identity exchanges the job's OIDC token for a store-scoped service account token", async () => {
  const oidc = "header.payload.signature";
  const { requests, fetchImpl } = recorder(request => {
    if (request.url.startsWith("https://token.actions.example/")) return json({ value: oidc });
    if (request.url === "https://sts.googleapis.com/v1/token") return json({ access_token: "federated", token_type: "Bearer", expires_in: 3600 });
    return json({ accessToken: "minted", expireTime: "2026-09-29T00:00:00Z" });
  });
  const token = await workloadIdentityToken({ provider, serviceAccount, requestUrl: "https://token.actions.example/id?api-version=2.0",
    requestToken: "request-token", fetchImpl });
  assert.equal(token, "minted");
  const [github, sts, iam] = requests;
  const audience = new URL(github.url).searchParams.get("audience");
  assert.equal(audience, `https://iam.googleapis.com/${provider}`);
  assert.equal(new URL(github.url).searchParams.get("api-version"), "2.0");
  assert.equal(github.headers.Authorization, "bearer request-token");
  assert.equal(sts.headers.Authorization, undefined, "STS rejects an Authorization header");
  assert.deepEqual(JSON.parse(sts.body), {
    grantType: "urn:ietf:params:oauth:grant-type:token-exchange", audience: `//iam.googleapis.com/${provider}`,
    scope: "https://www.googleapis.com/auth/cloud-platform", requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
    subjectToken: oidc, subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
  });
  assert.equal(iam.url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`);
  assert.equal(iam.headers.Authorization, "Bearer federated");
  assert.deepEqual(JSON.parse(iam.body), { scope: ["https://www.googleapis.com/auth/chromewebstore"], lifetime: "1800s" });
  assert(requests.every(request => request.redirect === "error"));
});

test("workload identity rejects unusable configuration before any request", async () => {
  const { requests, fetchImpl } = recorder(() => json({}));
  const base = { provider, serviceAccount, requestUrl: "https://token.actions.example/id", requestToken: "t", fetchImpl };
  await assert.rejects(workloadIdentityToken({ ...base, provider: "projects/my-project/locations/global/workloadIdentityPools/p/providers/x" }), /CWS_WORKLOAD_IDENTITY_PROVIDER/);
  await assert.rejects(workloadIdentityToken({ ...base, serviceAccount: "someone@gmail.com" }), /CWS_SERVICE_ACCOUNT/);
  await assert.rejects(workloadIdentityToken({ ...base, requestToken: undefined }), /id-token: write/);
  await assert.rejects(workloadIdentityToken({ ...base, requestUrl: "http://token.actions.example/id" }), /HTTPS/);
  assert.equal(requests.length, 0);
});

test("Google errors keep their bounded reason, never the whole body", async () => {
  const { fetchImpl } = recorder(request => request.url.includes("sts.googleapis.com")
    ? json({ error: "invalid_grant", error_description: "The audience in ID Token does not match the expected audience." }, 400)
    : json({ value: "a.b.c" }));
  await assert.rejects(workloadIdentityToken({ provider, serviceAccount, requestUrl: "https://token.actions.example/id", requestToken: "t", fetchImpl }),
    error => error instanceof GoogleApiError && error.status === 400 && /invalid_grant: The audience in ID Token/.test(error.message));
});

test("the store client sends documented V2 requests only to its own item", async () => {
  const { requests, fetchImpl } = recorder(request => {
    if (request.url.endsWith(":fetchStatus")) return json({ itemId, name: `publishers/pub/items/${itemId}` });
    if (request.url.endsWith(":upload")) return json({ itemId, uploadState: "SUCCEEDED", crxVersion: "1.2.0" });
    if (request.url.endsWith(":publish")) return json({ itemId, state: "PENDING_REVIEW" });
    return json({});
  });
  const store = new ChromeWebStore({ publisherId: "pub", itemId, token: "access", fetchImpl });
  await store.fetchStatus();
  const bytes = Buffer.from("zip");
  await store.upload(bytes);
  await store.publish({ publishType: "DEFAULT_PUBLISH" });
  await store.cancelSubmission();
  assert.deepEqual(requests.map(request => `${request.method} ${request.url}`), [
    `GET https://chromewebstore.googleapis.com/v2/publishers/pub/items/${itemId}:fetchStatus`,
    `POST https://chromewebstore.googleapis.com/upload/v2/publishers/pub/items/${itemId}:upload`,
    `POST https://chromewebstore.googleapis.com/v2/publishers/pub/items/${itemId}:publish`,
    `POST https://chromewebstore.googleapis.com/v2/publishers/pub/items/${itemId}:cancelSubmission`,
  ]);
  assert(requests.every(request => request.headers.Authorization === "Bearer access"));
  assert.equal(requests[1].body, bytes, "the package is the raw request body");
  assert.equal(requests[1].headers["Content-Type"], undefined);
  assert.deepEqual(JSON.parse(requests[2].body), { publishType: "DEFAULT_PUBLISH" });
  assert.throws(() => new ChromeWebStore({ publisherId: "pub/../x", itemId, token: "t", fetchImpl }), /CWS_PUBLISHER_ID/);
  assert.throws(() => new ChromeWebStore({ publisherId: "pub", itemId: "not-an-item", token: "t", fetchImpl }), /CWS_ITEM_ID/);
});

test("a response for another item is refused", async () => {
  const { fetchImpl } = recorder(() => json({ itemId: "ponmlkjihgfedcbaponmlkjihgfedcba" }));
  await assert.rejects(new ChromeWebStore({ publisherId: "pub", itemId, token: "t", fetchImpl }).fetchStatus(), /different item/);
});

test("store API errors report Google's status and message", async () => {
  const { fetchImpl } = recorder(() => json({ error: { code: 400, status: "FAILED_PRECONDITION", message: "Please complete the Privacy tab before publishing." } }, 400));
  await assert.rejects(new ChromeWebStore({ publisherId: "pub", itemId, token: "t", fetchImpl }).publish({}),
    /Chrome Web Store publish returned HTTP 400: FAILED_PRECONDITION: Please complete the Privacy tab/);
});

test("Chrome versions compare numerically with missing components as zero", () => {
  assert(compareChromeVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareChromeVersions("1.2", "1.2.0.0"), 0);
  assert.throws(() => compareChromeVersions("1.65536", "1.0"), /65535/);
});

test("status summaries fail closed on malformed revisions", () => {
  assert.deepEqual(storeState({ itemId }).published, null);
  assert.throws(() => storeState({ submittedItemRevisionStatus: { distributionChannels: [] } }), /no state/);
  assert.throws(() => storeState({ publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "x" }] } }), /Chrome requires/);
});

// A stateful model of the documented item lifecycle.
class FakeStore {
  constructor(status = {}) {
    this.itemId = itemId;
    this.status = { itemId, ...status };
    this.calls = [];
    this.pollMs = 1;
    this.uploadWaitMs = 1_000;
    this.uploadResult = version => ({ itemId, uploadState: "SUCCEEDED", crxVersion: version });
    this.onPublish = () => {
      this.status.submittedItemRevisionStatus = { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: this.draft, deployPercentage: 100 }] };
      return { itemId, state: "PENDING_REVIEW" };
    };
  }
  async fetchStatus() { this.calls.push("fetchStatus"); return structuredClone(this.status); }
  async upload(bytes) {
    this.calls.push("upload");
    this.draft = JSON.parse(bytes.toString()).version;
    return this.uploadResult(this.draft);
  }
  async publish(body) { this.calls.push(`publish:${JSON.stringify(body)}`); return this.onPublish(); }
  async cancelSubmission() {
    this.calls.push("cancelSubmission");
    this.status.submittedItemRevisionStatus = { ...this.status.submittedItemRevisionStatus, state: "CANCELLED" };
    return {};
  }
}

async function packageFor(version) {
  const directory = await mkdtemp(join(tmpdir(), "tab-gantry-cws-"));
  const bytes = Buffer.from(JSON.stringify({ version }));
  await writeFile(join(directory, "chrome.zip"), bytes);
  return { directory, context: { version, chrome: { sha256: sha256(bytes), bytes: bytes.length } } };
}

async function submit(store, version = "1.2.0", options = {}) {
  const { directory, context } = await packageFor(version);
  const writes = [];
  try {
    const result = await submitChromeRelease({ store, context, zipPath: join(directory, "chrome.zip"),
      beforeWrite: async () => { writes.push(store.calls.length); }, report: () => {}, ...options });
    return { result, writes };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const revision = (state, crxVersion, deployPercentage = 100) => ({ state, distributionChannels: [{ crxVersion, deployPercentage }] });

test("a fresh version is uploaded, submitted for default publishing and verified", async () => {
  const store = new FakeStore({ publishedItemRevisionStatus: revision("PUBLISHED", "1.1.0") });
  const { result, writes } = await submit(store);
  assert.equal(result.state, "awaiting-review");
  assert.deepEqual(store.calls, ["fetchStatus", "upload", "fetchStatus", 'publish:{"publishType":"DEFAULT_PUBLISH"}', "fetchStatus"]);
  assert.deepEqual(writes, [1, 3], "the tag is rechecked immediately before each write");
});

test("an already submitted, staged or published version is reconciled without writes", async () => {
  for (const [status, state] of [
    [{ submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.2.0") }, "awaiting-review"],
    [{ submittedItemRevisionStatus: revision("STAGED", "1.2.0") }, "staged"],
    [{ publishedItemRevisionStatus: revision("PUBLISHED", "1.2.0", 10) }, "published"],
    [{ publishedItemRevisionStatus: revision("PUBLISHED_TO_TESTERS", "1.2.0") }, "published"],
    [{ publishedItemRevisionStatus: revision("PUBLISHED", "1.3.0") }, "superseded"],
  ]) {
    const store = new FakeStore(status);
    const { result, writes } = await submit(store);
    assert.equal(result.state, state);
    assert.deepEqual(store.calls, ["fetchStatus"]);
    assert.deepEqual(writes, []);
  }
});

test("rejected and cancelled submissions need a person, never an automatic resubmission", async () => {
  for (const state of ["REJECTED", "CANCELLED"]) {
    const store = new FakeStore({ submittedItemRevisionStatus: revision(state, "1.2.0") });
    await assert.rejects(submit(store), error => error instanceof SubmissionOutcomeError && error.state === state);
    assert.deepEqual(store.calls, ["fetchStatus"]);
  }
});

test("another version in review blocks submission unless that exact version is superseded", async () => {
  const pending = { publishedItemRevisionStatus: revision("PUBLISHED", "1.0.0"), submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.1.0") };
  let store = new FakeStore(structuredClone(pending));
  await assert.rejects(submit(store), error => error instanceof PendingSubmissionError && error.pending === "1.1.0");
  assert.deepEqual(store.calls, ["fetchStatus"]);
  store = new FakeStore(structuredClone(pending));
  await assert.rejects(submit(store, "1.2.0", { supersede: "1.0.9" }), PendingSubmissionError);
  assert.deepEqual(store.calls, ["fetchStatus"]);
  store = new FakeStore(structuredClone(pending));
  const { result, writes } = await submit(store, "1.2.0", { supersede: "1.1.0" });
  assert.equal(result.state, "awaiting-review");
  assert.deepEqual(store.calls.slice(0, 4), ["fetchStatus", "cancelSubmission", "fetchStatus", "upload"]);
  assert.deepEqual(writes, [1, 3, 5]);
});

test("asynchronous package processing is polled until accepted", async () => {
  const store = new FakeStore();
  store.uploadResult = () => ({ itemId, uploadState: "IN_PROGRESS" });
  let polls = 0;
  const fetchStatus = store.fetchStatus.bind(store);
  store.fetchStatus = async () => {
    const status = await fetchStatus();
    if (store.calls.includes("upload") && !store.calls.some(call => call.startsWith("publish"))) {
      status.lastAsyncUploadState = ++polls < 3 ? "IN_PROGRESS" : "SUCCEEDED";
    }
    return status;
  };
  const { result } = await submit(store);
  assert.equal(result.state, "awaiting-review");
  assert.equal(polls, 4, "three processing polls, then the pre-publish recheck");
});

test("a failed or mismatched upload is never submitted", async () => {
  let store = new FakeStore();
  store.uploadResult = () => ({ itemId, uploadState: "FAILED" });
  await assert.rejects(submit(store), /did not accept the package/);
  assert(!store.calls.some(call => call.startsWith("publish")));
  store = new FakeStore();
  store.uploadResult = () => ({ itemId, uploadState: "SUCCEEDED", crxVersion: "1.1.9" });
  await assert.rejects(submit(store), /read version 1\.1\.9 from the package, not 1\.2\.0/);
  assert(!store.calls.some(call => call.startsWith("publish")));
});

test("a submission made by another writer during processing is reconciled, not duplicated", async () => {
  const store = new FakeStore();
  const upload = store.upload.bind(store);
  store.upload = async bytes => {
    const result = await upload(bytes);
    store.status.submittedItemRevisionStatus = revision("PENDING_REVIEW", "1.2.0");
    return result;
  };
  const { result } = await submit(store);
  assert.equal(result.state, "awaiting-review");
  assert(!store.calls.some(call => call.startsWith("publish")));
});

test("a submission that is not yet visible asks for a rerun", async () => {
  const store = new FakeStore();
  store.onPublish = () => ({ itemId, state: "PENDING_REVIEW" });
  await assert.rejects(submit(store), /not visible yet; rerun/);
});

test("package, tag and takedown checks stop before any write", async () => {
  const { directory, context } = await packageFor("1.2.0");
  try {
    let store = new FakeStore();
    await assert.rejects(submitChromeRelease({ store, context: { ...context, chrome: { ...context.chrome, sha256: "0".repeat(64) } },
      zipPath: join(directory, "chrome.zip") }), /differs from the tested ZIP/);
    assert.deepEqual(store.calls, []);
    store = new FakeStore();
    await assert.rejects(submitChromeRelease({ store, context, zipPath: join(directory, "chrome.zip"),
      beforeWrite: async () => { throw new Error("Remote tag moved"); } }), /Remote tag moved/);
    assert.deepEqual(store.calls, ["fetchStatus"]);
    store = new FakeStore({ takenDown: true });
    await assert.rejects(submitChromeRelease({ store, context, zipPath: join(directory, "chrome.zip") }), /took this item down/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publish warnings are reported without being echoed unbounded", async () => {
  const store = new FakeStore();
  const onPublish = store.onPublish;
  store.onPublish = () => ({ ...onPublish(), warningInfo: { warnings: [{ reason: "LISTING", description: "x".repeat(900) }] } });
  const { directory, context } = await packageFor("1.2.0");
  const reports = [];
  try {
    await submitChromeRelease({ store, context, zipPath: join(directory, "chrome.zip"), report: entry => reports.push(entry) });
  } finally { await rm(directory, { recursive: true, force: true }); }
  const warning = reports.find(entry => entry.warning)?.warning;
  assert.match(warning, /^LISTING: x+$/u);
  assert(warning.length <= 500);
});

async function stageContext(context) {
  const directory = await mkdtemp(join(tmpdir(), "tab-gantry-cws-run-"));
  await writeFile(join(directory, "context.json"), JSON.stringify(context));
  return directory;
}

test("the release job skips sources without Chrome support and unconfigured stores", async () => {
  const base = { tag: "v1.2.0", commit: "a".repeat(40), version: "1.2.0" };
  const env = { RELEASE_TAG: base.tag, RELEASE_COMMIT: base.commit };
  let directory = await stageContext(base);
  const logs = [];
  try {
    assert.deepEqual(await runChromeSubmission({ env, directory, retired: new Set(), log: line => logs.push(line) }), { state: "not-applicable" });
  } finally { await rm(directory, { recursive: true, force: true }); }
  directory = await stageContext({ ...base, chrome: { sha256: "0".repeat(64), bytes: 1 } });
  try {
    assert.deepEqual(await runChromeSubmission({ env, directory, retired: new Set(), log: line => logs.push(line) }), { state: "not-configured" });
    await assert.rejects(runChromeSubmission({ env: { ...env, CWS_ITEM_ID: itemId, CWS_ACCESS_TOKEN: "t" }, directory, retired: new Set(), log: () => {} }),
      /Configure CWS_PUBLISHER_ID/);
    await assert.rejects(runChromeSubmission({ env: { ...env, CWS_ITEM_ID: itemId }, directory, retired: new Set([base.tag]), log: () => {} }),
      /explicitly retired/);
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.match(logs.join("\n"), /predates Chrome support/);
});

test("the release job submits with the tag guard and reports a blocked review", async () => {
  const bytes = Buffer.from(JSON.stringify({ version: "1.2.0" }));
  const context = { tag: "v1.2.0", commit: "b".repeat(40), version: "1.2.0", chrome: { sha256: sha256(bytes), bytes: bytes.length } };
  const directory = await stageContext(context);
  await writeFile(join(directory, "chrome.zip"), bytes);
  const outputs = join(directory, "output");
  const env = { RELEASE_TAG: context.tag, RELEASE_COMMIT: context.commit, GITHUB_OUTPUT: outputs };
  const github = { commit: async tag => (tag === context.tag ? context.commit : null) };
  try {
    let store = new FakeStore();
    assert.equal((await runChromeSubmission({ env, directory, store, github, retired: new Set(), log: () => {} })).state, "awaiting-review");
    store = new FakeStore({ submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.1.0") });
    const warnings = [];
    assert.deepEqual(await runChromeSubmission({ env, directory, store, github, retired: new Set(), log: () => {}, warn: line => warnings.push(line) }),
      { state: "blocked-by-pending-review" });
    assert.match(warnings[0], /^::error title=Another Chrome Web Store version is in review::/u);
    assert.doesNotMatch(warnings[0], /\n/u);
    assert.equal(await readFile(outputs, "utf8"), "state=awaiting-review\nstate=blocked-by-pending-review\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an older version never follows a newer rejected or cancelled submission", async () => {
  // A 1.1.0 review cancelled for 1.2.0 must not return after 1.2.0 is rejected.
  for (const state of ["REJECTED", "CANCELLED"]) {
    const store = new FakeStore({ publishedItemRevisionStatus: revision("PUBLISHED", "1.0.0"), submittedItemRevisionStatus: revision(state, "1.2.0") });
    const { result, writes } = await submit(store, "1.1.0");
    assert.deepEqual([result.state, result.newer], ["superseded", "1.2.0"]);
    assert.deepEqual(store.calls, ["fetchStatus"]);
    assert.deepEqual(writes, []);
  }
});

test("an unknown store state fails closed before any write", async () => {
  const store = new FakeStore({ submittedItemRevisionStatus: revision("IN_REVIEW_NEW_STATE", "1.1.0") });
  await assert.rejects(submit(store), /Unsupported Chrome Web Store state IN_REVIEW_NEW_STATE/);
  assert.deepEqual(store.calls, ["fetchStatus"]);
});

test("after delayed processing the store must have submitted exactly this version", async () => {
  const store = new FakeStore();
  store.uploadResult = () => ({ itemId, uploadState: "IN_PROGRESS" });
  const fetchStatus = store.fetchStatus.bind(store);
  store.fetchStatus = async () => ({ ...(await fetchStatus()), lastAsyncUploadState: "SUCCEEDED" });
  store.onPublish = () => {
    store.status.submittedItemRevisionStatus = revision("PENDING_REVIEW", "1.1.9");
    return { itemId, state: "PENDING_REVIEW" };
  };
  await assert.rejects(submit(store), /submitted 1\.1\.9, not 1\.2\.0/);
});

test("only a run that uploaded credits the tested digest, and store warnings are annotated", async () => {
  const bytes = Buffer.from(JSON.stringify({ version: "1.2.0" }));
  const context = { tag: "v1.2.0", commit: "c".repeat(40), version: "1.2.0", chrome: { sha256: sha256(bytes), bytes: bytes.length } };
  const directory = await stageContext(context);
  await writeFile(join(directory, "chrome.zip"), bytes);
  const summary = join(directory, "summary");
  const env = { RELEASE_TAG: context.tag, RELEASE_COMMIT: context.commit, GITHUB_STEP_SUMMARY: summary };
  const github = { commit: async () => context.commit };
  try {
    const warnings = [];
    const uploaded = new FakeStore({ warned: true });
    assert.equal((await runChromeSubmission({ env, directory, store: uploaded, github, retired: new Set(), log: () => {}, warn: line => warnings.push(line) })).uploaded, true);
    assert.match(await readFile(summary, "utf8"), new RegExp(`This run submitted the tested package \\(SHA-256 \`${context.chrome.sha256}\`\\)`, "u"));
    assert(warnings.some(line => line.startsWith("::warning title=Chrome Web Store::The Chrome Web Store warned this item")));
    await writeFile(summary, "");
    const reconciled = new FakeStore({ submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.2.0") });
    assert.equal((await runChromeSubmission({ env, directory, store: reconciled, github, retired: new Set(), log: () => {}, warn: () => {} })).uploaded, undefined);
    const text = await readFile(summary, "utf8");
    assert.match(text, /did not upload a package/u);
    assert.doesNotMatch(text, /SHA-256/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
