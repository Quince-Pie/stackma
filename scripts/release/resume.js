import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionFromTag } from "./package.js";
import { readRetirements } from "./retirement.js";

const api = "https://api.github.com";
const amoAddon = "https://addons.mozilla.org/api/v5/addons/addon/stackma%40extensions.local/";
export const releaseWorkflow = "release.yml";
// Automatic dispatches per tag in retained GitHub history. Deleted/expired runs
// cannot be counted. A second retained attempt needs a person to investigate.
export const maximumAutomaticAttempts = 2;
const maximumVersionReads = 100;
const amoPageSize = 50; // Published API limit and CustomPageNumberPagination.
const maximumHistory = 1000; // GitHub's limit for a runs search using `event`.
const maximumResponseBytes = 8 * 1024 * 1024;
const activeStatuses = ["queued", "in_progress", "waiting", "requested", "pending"];

/** A service or network condition that the next scheduled run may not see. */
export class TransientError extends Error {}

async function request(fetchImpl, url, options = {}, timeoutMs = 30_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return { response: await fetchImpl(url, { ...options, redirect: "error", signal }), signal };
  } catch (error) {
    throw new TransientError(`Request to ${new URL(url).host} failed (${error instanceof Error ? error.name : "unknown error"})`);
  }
}

// The timeout covers the response body as well as headers; never buffer an
// unbounded provider response or expose its possibly sensitive text in errors.
async function jsonBody(response, signal, limit = maximumResponseBytes) {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Provider JSON exceeds the ${limit}-byte response bound`);
  }
  assert(response.body, "Provider returned an empty JSON response");
  const reader = response.body.getReader();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new TransientError("Provider response body timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  // A deadline already expired at headers can fail before the first race.
  void aborted.catch(() => {});
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new TransientError("Provider response body timed out");
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      assert(bytes <= limit, `Provider JSON exceeds the ${limit}-byte response bound`);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof TypeError) throw new TransientError("Provider response body was interrupted");
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
  catch { throw new Error("Provider returned malformed JSON"); }
}

// 429, 5xx and GitHub's rate-limit 403s (spent quota or Retry-After) are temporary.
function statusError(service, response) {
  const { status, headers } = response;
  const limited = status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after"));
  const message = `${service} returned HTTP ${status}${limited ? " (rate limited)" : ""}`;
  return status === 429 || status >= 500 || limited ? new TransientError(message) : new Error(message);
}

/** GitHub REST access. A token, when present, is sent only to api.github.com. */
export class GitHubClient {
  constructor(repository, token, fetchImpl = fetch, { timeoutMs = 30_000, responseBytes = maximumResponseBytes } = {}) {
    assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.responseBytes = responseBytes;
  }
  headers() {
    return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }
  async get(path) {
    const { response, signal } = await request(this.fetchImpl, `${api}/repos/${this.repository}/${path}`, { headers: this.headers() }, this.timeoutMs);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw statusError("GitHub", response); }
    return jsonBody(response, signal, this.responseBytes);
  }
  async dispatch(tag) {
    assert(this.token, "Dispatching Publish release requires GH_TOKEN");
    versionFromTag(tag);
    const { response, signal } = await request(this.fetchImpl, `${api}/repos/${this.repository}/actions/workflows/${releaseWorkflow}/dispatches`, {
      method: "POST", headers: { ...this.headers(), "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main", inputs: { tag } }),
    }, this.timeoutMs);
    if (response.status === 204) return null;
    if (response.status !== 200) { await response.body?.cancel(); throw statusError("Dispatching Publish release", response); }
    // API version 2026-03-10 always returns the new run's identity.
    const run = await jsonBody(response, signal, this.responseBytes);
    return typeof run?.html_url === "string" && run.html_url.startsWith(`https://github.com/${this.repository}/actions/runs/`) ? run.html_url : null;
  }
}

function stable(tag) {
  try { versionFromTag(tag); return true; } catch { return false; }
}

function compareTags(a, b) {
  const [x, y] = [a, b].map(tag => tag.slice(1).split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

async function amoGet(fetchImpl, url) {
  const { response, signal } = await request(fetchImpl, url, { headers: { Accept: "application/json" } });
  // Anonymous callers see only public listings and their approved listed
  // versions. Pending, disabled and absent versions are all "not yet".
  if ([401, 403, 404].includes(response.status)) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw statusError("AMO", response); }
  return jsonBody(response, signal);
}

function validateVersion(detail) {
  assert(Number.isSafeInteger(detail.id) && detail.id > 0, "Invalid AMO version identity");
  assert(typeof detail.version === "string" && detail.version.length > 0 && detail.version.length <= 255, "Invalid AMO version string");
  assert.equal(detail.channel, "listed", "Unexpected AMO version channel");
}

async function pointVersions(wanted, approved, fetchImpl) {
  for (const version of wanted) {
    if (approved.has(version)) continue;
    const detail = await amoGet(fetchImpl, `${amoAddon}versions/v${encodeURIComponent(version)}/`);
    if (!detail) continue;
    validateVersion(detail);
    assert.equal(detail.version, version, "Unexpected AMO version identity");
    assert(["public", "unreviewed", "disabled"].includes(detail.file?.status), "Unexpected AMO version status");
    if (detail.file.status === "public") approved.add(version);
  }
  return approved;
}

/** Versions that the public AMO API shows as approved on the public listing. No credentials are sent. */
export async function approvedVersions(versions, fetchImpl = fetch) {
  const approved = new Set();
  if (versions.length === 0) return approved;
  const wanted = new Set(versions), seen = new Set(), ids = new Set();
  const addon = await amoGet(fetchImpl, amoAddon);
  if (!addon) return approved;
  assert.equal(addon.guid, "stackma@extensions.local", "Unexpected AMO listing");
  if (addon.status !== "public" || addon.is_disabled !== false) return approved;
  // One detail read is always sufficient for one candidate, even when the
  // public history is very large. Larger sets first buy one page of information.
  if (wanted.size === 1) return pointVersions(wanted, approved, fetchImpl);
  const base = new URL(`${amoAddon}versions/`);
  let url = `${base}?page_size=${amoPageSize}`, expectedCount;
  for (let page = 1; page <= maximumVersionReads; page++) {
    // The default anonymous list excludes disabled, rejected, unreviewed and
    // unlisted versions. A large history of superseded tags adds no requests.
    const history = await amoGet(fetchImpl, url);
    if (!history) return new Set(); // The listing became non-public mid-scan.
    assert(Array.isArray(history.results), "Invalid AMO version history");
    assert(Number.isSafeInteger(history.count) && history.count >= 0, "Invalid AMO version count");
    assert.equal(history.page_size, amoPageSize, "Unexpected AMO page size");
    assert(history.results.length <= amoPageSize, "Unexpected AMO result count");
    if (expectedCount !== undefined && expectedCount !== history.count) {
      throw new IncompleteHistory("AMO public version history changed during pagination. Check again after approval activity settles.");
    }
    expectedCount = history.count;
    if (history.results.length !== Math.min(amoPageSize, history.count - seen.size)) {
      throw new IncompleteHistory("AMO public version history returned an incomplete page; no publication was dispatched.");
    }
    for (const detail of history.results) {
      validateVersion(detail);
      assert.equal(detail.file?.status, "public", "Unexpected AMO public version status");
      if (seen.has(detail.version) || ids.has(detail.id)) throw new IncompleteHistory("AMO public version history repeated a version; no publication was dispatched.");
      seen.add(detail.version);
      ids.add(detail.id);
      if (wanted.has(detail.version)) approved.add(detail.version);
    }
    assert(history.next === null || typeof history.next === "string", "Invalid AMO pagination link");
    if (history.next !== null) {
      const next = new URL(history.next);
      assert(next.origin === base.origin && decodeURIComponent(next.pathname) === decodeURIComponent(base.pathname) &&
        !next.username && !next.password && !next.hash, "Unexpected AMO pagination destination");
      assert.deepEqual([...next.searchParams.keys()].sort(), ["page", "page_size"], "Unexpected AMO pagination query");
      assert.equal(next.searchParams.get("page"), String(page + 1), "Unexpected AMO next page");
      assert.equal(next.searchParams.get("page_size"), String(amoPageSize), "Unexpected AMO next page size");
      url = next.href;
    }
    if (seen.size > history.count || ((history.next === null) !== (seen.size === history.count))) {
      throw new IncompleteHistory("AMO public version history does not match its reported count; no publication was dispatched.");
    }
    if (approved.size === wanted.size || history.next === null) return approved;
    const points = wanted.size - approved.size;
    const pages = Math.ceil((history.count - seen.size) / amoPageSize);
    // Exact remaining service-call costs under this validated count. Ties use
    // point reads, avoiding further pagination races. The first page's cost is
    // already paid; this does not claim dominance over knowing the data upfront.
    if (points <= pages && points <= maximumVersionReads - page) return pointVersions(wanted, approved, fetchImpl);
    // If neither complete route fits, another page may still find every
    // candidate early. Keep that opportunity within the same fixed read bound.
  }
  throw new IncompleteHistory(`AMO approval checks cannot complete within the ${maximumVersionReads}-read automatic bound. Inspect approved versions and resume the affected tags manually.`);
}

async function publishedTags(github) {
  const tags = new Set(), owned = new Set();
  for (let page = 1; page <= 100; page++) {
    const releases = await github.get(`releases?per_page=100&page=${page}`);
    assert(Array.isArray(releases), "Cannot establish release history");
    for (const release of releases) if (!release.draft) {
      tags.add(release.tag_name);
      const marker = /^<!-- stackma-release:(v\d+\.\d+\.\d+):[a-f0-9]{40}:[a-f0-9]{64}:[a-f0-9]{64} -->/u.exec(release.body ?? "");
      if (stable(release.tag_name) && marker?.[1] === release.tag_name) owned.add(release.tag_name);
    }
    if (releases.length < 100) return { tags, owned };
  }
  throw new Error("Release history reaches the 10,000-entry bound; inspect it explicitly");
}

class IncompleteHistory extends Error {}

async function automaticAttempts(github, { allActors = false, since } = {}) {
  const counts = new Map(), ids = new Set(), runs = [];
  let expectedCount;
  for (let page = 1; page <= maximumHistory / 100; page++) {
    const filter = allActors ? `&created=${encodeURIComponent(`>=${since}`)}` : "&actor=github-actions%5Bbot%5D";
    const history = await github.get(`actions/workflows/${releaseWorkflow}/runs?event=workflow_dispatch${filter}&per_page=100&page=${page}`);
    assert(Array.isArray(history?.workflow_runs), "Cannot establish earlier automatic attempts");
    const count = history.total_count;
    if (!Number.isSafeInteger(count) || count < 0 || count >= maximumHistory) {
      throw new IncompleteHistory(`Dispatch history is not provably complete below GitHub's ${maximumHistory}-run search bound. Inspect retained Publish release runs before resuming manually.`);
    }
    if (expectedCount !== undefined && expectedCount !== count) {
      throw new IncompleteHistory("Dispatch history changed during pagination. No release was dispatched; check again after publisher activity settles.");
    }
    expectedCount = count;
    assert(history.workflow_runs.length <= 100, "Unexpected dispatch history page size");
    for (const run of history.workflow_runs) {
      assert(Number.isSafeInteger(run.id) && run.id > 0, "Invalid workflow run identity");
      assert.equal(run.event, "workflow_dispatch", "Unexpected workflow run event");
      assert.equal(typeof run.display_title, "string", "Missing workflow run title");
      if (allActors) assert.equal(typeof run.actor?.login, "string", "Missing workflow run actor");
      else assert.equal(run.actor?.login, "github-actions[bot]", "Unexpected workflow run actor");
      if (ids.has(run.id)) throw new IncompleteHistory("Dispatch history repeated a run during pagination. No release was dispatched; inspect changing or incomplete history.");
      ids.add(run.id);
      runs.push(run);
      // actor started the original run and survives reruns by a different user.
      if (run.actor.login === "github-actions[bot]") counts.set(run.display_title, (counts.get(run.display_title) ?? 0) + 1);
    }
    if (ids.size > count || (history.workflow_runs.length < 100 && ids.size !== count)) {
      throw new IncompleteHistory("Dispatch history ended before its reported count was established. No release was dispatched; inspect incomplete history.");
    }
    if (ids.size === count) return { counts, runs };
  }
  throw new IncompleteHistory(`Dispatch history reaches the ${maximumHistory}-run search bound; inspect it before resuming manually.`);
}

export const publicationJobName = "Publish the verified signed release";
export const publicationVerificationStepName = "Reconcile, publish and verify the immutable release";
const failedConclusions = new Set(["failure", "cancelled", "timed_out"]);
function runTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new IncompleteHistory("Publisher history has an invalid completion timestamp; inspect its verification results.");
  }
  return Date.parse(value);
}

async function incompletePublications(github, owned, runs) {
  const incomplete = new Map(), cached = new Map();
  let reads = 0;
  const gate = async run => {
    if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new IncompleteHistory("Publisher run attempt is unavailable; inspect final publication verification.");
    const key = `${run.id}:${run.run_attempt}`;
    if (cached.has(key)) return cached.get(key);
    if (++reads > 50) throw new IncompleteHistory("Publication verification exceeds the 50-job-history-read bound; inspect unresolved published releases.");
    const result = await github.get(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (!Array.isArray(result?.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count > 100 || result.total_count !== result.jobs.length) {
      throw new IncompleteHistory(`Jobs for publisher run ${run.id} are missing or incomplete; rerun it to establish final verification.`);
    }
    assert(result.jobs.every(job => job.run_id === run.id), "Unexpected publisher job identity");
    const jobs = result.jobs.filter(job => job.name === publicationJobName);
    assert(jobs.length <= 1, "Duplicate publication verification job");
    const steps = jobs[0]?.steps ?? [];
    assert(Array.isArray(steps), "Invalid publication verification steps");
    const matches = steps.filter(step => step.name === publicationVerificationStepName);
    assert(matches.length <= 1, "Duplicate publication verification step");
    const step = matches[0];
    const verified = step?.status === "completed" && step.conclusion === "success" ? runTime(step.completed_at) : null;
    cached.set(key, verified);
    return verified;
  };
  // Successful first attempts need no jobs query. Reruns can hide an earlier
  // failure behind a green awaiting-review result, so inspect their actual gate.
  for (const run of runs) {
    const tag = run.display_title.replace(/^Publish release /u, "");
    if (!owned.has(tag) || run.status !== "completed" || (!failedConclusions.has(run.conclusion) && !(run.run_attempt > 1))) continue;
    if (await gate(run) !== null) continue; // Diagnostic upload failed after verification.
    const when = runTime(run.updated_at);
    if (!incomplete.has(tag) || when > incomplete.get(tag).when) incomplete.set(tag, { run, when });
  }
  if (incomplete.size === 0) return incomplete;
  const clearVerified = async candidates => {
    for (const run of candidates) {
      const tag = run.display_title.replace(/^Publish release /u, "");
      const failure = incomplete.get(tag);
      if (!failure || run.status !== "completed" || runTime(run.updated_at) < failure.when) continue;
      const verified = await gate(run);
      if (verified !== null && verified > failure.when) incomplete.delete(tag);
    }
  };
  await clearVerified(runs);
  if (incomplete.size > 0) {
    // A fresh human dispatch can also finish recovery. Limit that search to the
    // relevant failure window; actor remains the bot for a human rerun.
    const since = new Date(Math.min(...[...incomplete.values()].map(({ run }) => runTime(run.created_at)))).toISOString();
    const later = await automaticAttempts(github, { allActors: true, since });
    await clearVerified(later.runs);
  }
  return incomplete;
}

/**
 * Decide the next action. At most one approved unpublished tag or incomplete
 * owned publication is dispatched, and never while a publisher is active.
 */
export async function planResume({ github, fetchImpl = fetch, retired }) {
  // A retired tag never receives a GitHub release; resolve and sign refuse it too.
  retired ??= await readRetirements();
  const refs = await github.get("git/matching-refs/tags/v");
  assert(Array.isArray(refs), "Cannot list release tags");
  const published = await publishedTags(github);
  const unpublished = refs.map(ref => String(ref.ref).replace(/^refs\/tags\//u, ""))
    .filter(tag => stable(tag) && !published.tags.has(tag) && !retired.has(tag)).sort(compareTags).reverse();
  const notes = [];
  const attention = [];
  let approved;
  try { approved = await approvedVersions(unpublished.map(tag => tag.slice(1)), fetchImpl); }
  catch (error) {
    if (!(error instanceof IncompleteHistory)) throw error;
    return { action: "attention", reason: "Mozilla approval history needs inspection.", notes, attention: [error.message] };
  }
  let ready = unpublished.filter(tag => approved.has(tag.slice(1))).sort(compareTags);
  let counts, incomplete = new Map();
  if (ready.length || published.owned.size) {
    try {
      const history = await automaticAttempts(github);
      counts = history.counts;
      incomplete = await incompletePublications(github, published.owned, history.runs);
    } catch (error) {
      if (!(error instanceof IncompleteHistory)) throw error;
      return { action: "attention", reason: "Publisher history needs inspection.", notes, attention: [error.message] };
    }
    ready = [...new Set([...ready, ...incomplete.keys()])].sort(compareTags);
  }
  if (ready.length === 0) return { action: "none", reason: "No approved unpublished version or retained incomplete publication needs recovery.", notes, attention };
  for (const status of activeStatuses) {
    // Inspect returned runs, not total_count, which large results report as text.
    const runs = await github.get(`actions/workflows/${releaseWorkflow}/runs?status=${status}&per_page=1`);
    assert(Array.isArray(runs?.workflow_runs), "Cannot establish Publish release activity");
    if (runs.workflow_runs.length > 0) return { action: "wait", reason: `Publish release has a ${status} run; check again at the next scheduled run.`, notes, attention };
  }
  let next;
  for (const tag of ready) {
    const attempts = counts.get(`Publish release ${tag}`) ?? 0;
    if (attempts < maximumAutomaticAttempts) next ??= { tag, attempts, ...(incomplete.has(tag) ? { published: true } : {}) };
    else if (incomplete.has(tag)) attention.push(`${tag}: publication exists, but final verification is incomplete after ${attempts} automatic runs. Inspect https://github.com/${github.repository}/actions/runs/${incomplete.get(tag).run.id} and rerun it; never delete or recreate the release.`);
    else attention.push(`${tag}: Mozilla approved it, but ${attempts} automatic Publish release runs did not publish it. Inspect the latest run, fix the cause and rerun it.`);
  }
  if (next) return { action: "dispatch", ...next, notes, attention };
  return { action: "attention", reason: "Release publication or final verification needs a person.", notes, attention };
}

const command = text => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export async function runResume({ github, fetchImpl = fetch, retired, dryRun = false, summary, log = console.log }) {
  let plan;
  try {
    plan = await planResume({ github, fetchImpl, retired });
    if (plan.action === "dispatch" && !dryRun) plan.run = await github.dispatch(plan.tag);
  } catch (error) {
    if (!(error instanceof TransientError)) throw error;
    plan = { action: "retry-later", reason: `${error.message}; the next scheduled run checks again.`, notes: [], attention: [] };
  }
  const lines = [];
  if (plan.action === "dispatch") {
    lines.push(`${dryRun ? "Would dispatch" : "Dispatched"} Publish release for ${plan.tag}: ${plan.published ? "publication exists and its final verification needs recovery" : "Mozilla approved it and no GitHub release exists yet"}.`);
    if (plan.run) lines.push(`Run: ${plan.run}`);
  } else {
    lines.push(plan.reason);
  }
  lines.push(...plan.attention, ...plan.notes);
  for (const item of plan.attention) log(`::error title=Release needs attention::${command(item)}`);
  for (const note of plan.notes) log(`::warning title=Release check incomplete::${command(note)}`);
  if (plan.action === "retry-later") log(`::warning title=Release status unavailable::${command(plan.reason)}`);
  log(lines.join("\n"));
  if (summary) await appendFile(summary, `## Resume approved releases\n\n${lines.join("\n\n")}\n`);
  return plan;
}

/**
 * Command-line entry. A tag that needs a person fails the run: GitHub notifies
 * the user who last changed the workflow's schedule, while failures of runs
 * dispatched by github-actions[bot] notify nobody.
 */
export async function cli({ argv = process.argv, env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const repository = argv.find(arg => arg.startsWith("--repository="))?.slice("--repository=".length) ?? env.GITHUB_REPOSITORY;
  assert(repository, "Set GITHUB_REPOSITORY or pass --repository=OWNER/NAME");
  const plan = await runResume({ github: new GitHubClient(repository, env.GH_TOKEN, fetchImpl), fetchImpl,
    dryRun: argv.includes("--dry-run"), summary: env.GITHUB_STEP_SUMMARY, log });
  return plan.attention.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await cli();
