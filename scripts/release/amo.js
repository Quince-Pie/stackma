import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "./package.js";
import { verifyPayload } from "./archive.js";
import { matchesAmoLicense } from "./license.js";

const origin = "https://addons.mozilla.org";
const baseUrl = new URL(`${origin}/api/v5/`);
const downloadOrigins = new Set([origin, "https://addons.mozilla.net"]);
const maximumDownload = 200_000_000;

export class ApiError extends Error {
  constructor(status) { super(`Mozilla API returned HTTP ${status}; inspect the AMO Developer Hub`); this.status = status; }
}

export class PendingReviewError extends Error {
  constructor(pending, version) {
    super(`AMO version ${pending.join(", ")} is still awaiting Mozilla review. Creating ${version} now would disable it: ` +
      `AMO disables every older listed version awaiting review when a new version is created. No AMO version was created for ${version}.\n\n` +
      `To keep the pending version, wait for Mozilla's decision, then rerun this workflow run or run Publish release with tag v${version}.\n` +
      (pending.length === 1
        ? `To replace it deliberately, run Publish release with tag v${version} and supersede ${pending[0]}.`
        : "Several listed versions await review; resolve them in the AMO Developer Hub before submitting another version."));
    this.name = "PendingReviewError";
    this.pending = pending;
  }
}

// addons-server's Version.from_upload() calls disable_old_files(): creating a
// listed version disables every older listed file that is still awaiting
// review ("unreviewed" in API v5). Unexpected entries fail closed.
export function pendingVersions(listed, target) {
  const pending = [];
  for (const entry of listed) {
    assert(typeof entry?.version === "string" && entry.channel === "listed" && typeof entry.file?.status === "string",
      "Cannot establish which AMO versions await review");
    if (entry.version !== target && entry.file.status === "unreviewed") pending.push(entry.version);
  }
  return pending.sort();
}

// AMO v5's documented HS256 authentication. Credentials never leave this
// object; each request gets a short-lived JWT, confined to the AMO origin.
export class JwtApiAuth {
  #issuer;
  #secret;
  constructor({ apiKey, apiSecret }) {
    assert(typeof apiKey === "string" && apiKey.length > 0, "Missing AMO issuer");
    assert(typeof apiSecret === "string" && apiSecret.length > 0, "Missing AMO secret");
    this.#issuer = apiKey;
    this.#secret = apiSecret;
  }
  async getAuthHeader() {
    const iat = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: this.#issuer, jti: randomUUID(), iat, exp: iat + 300 })}`;
    return `JWT ${input}.${createHmac("sha256", this.#secret).update(input).digest("base64url")}`;
  }
}

/** The narrow published v5 protocol; no dependency on web-ext's private client. */
export class ReleaseClient {
  constructor({ apiKey, apiSecret, timeoutMs = 20 * 60_000, fetchImpl = fetch, pollMs = 5_000 }) {
    this.apiAuth = new JwtApiAuth({ apiKey, apiSecret });
    this.signal = AbortSignal.timeout(timeoutMs);
    this.fetchImpl = fetchImpl;
    this.pollMs = pollMs;
  }

  fileFromSync(path) {
    return new File([readFileSync(path)], basename(path));
  }

  async fetch(url, method = "GET", body) {
    return this.nodeFetch(url, { method, body, headers: {
      Authorization: await this.apiAuth.getAuthHeader(), Accept: "application/json", "User-Agent": "stackma-release/2",
      ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
    } });
  }

  async doUploadSubmit(path, channel) {
    assert(["listed", "unlisted"].includes(channel), "Unsupported Mozilla distribution channel");
    const form = new FormData();
    form.set("channel", channel);
    form.set("upload", this.fileFromSync(path));
    const { uuid } = await this.fetchJson(new URL("addons/upload/", baseUrl), "POST", form);
    // Deployed FileUploadSerializer uses UUIDField(format="hex") (32 digits).
    // Also accept the canonical hyphenated UUID spelling, never URL syntax.
    assert(typeof uuid === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.test(uuid), "Invalid AMO upload identity");
    return this.waitRetry(result => {
      assert.equal(result.uuid, uuid, "AMO upload identity changed");
      assert.equal(typeof result.processed, "boolean", "Missing AMO validation state");
      if (!result.processed) return null;
      assert.equal(result.valid, true, "Mozilla validation rejected the upload; inspect the AMO Developer Hub");
      return uuid;
    }, new URL(`addons/upload/${uuid}/`, baseUrl), this.pollMs, 5 * 60_000);
  }

  async doVersionSubmit(id, uuid, source) {
    const form = new FormData();
    form.set("upload", uuid);
    form.set("source", this.fileFromSync(source));
    // Omission of license inherits the newest created listed version's terms.
    // The coordinator checks that predecessor immediately before this call.
    // Attaching source here avoids a later PATCH racing human review.
    return this.fetchJson(new URL(`addons/addon/${encodeURIComponent(id)}/versions/`, baseUrl), "POST", form);
  }

  nodeFetch(url, options) {
    url = new URL(url);
    assert(url.origin === origin && url.pathname.startsWith("/api/v5/") && !url.username && !url.password && !url.hash, "Unexpected authenticated API destination");
    return this.fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) });
  }

  async fetchJson(url, method = "GET", body) {
    const response = await this.fetch(url, method, body);
    if (!response.ok) { await response.body?.cancel(); throw new ApiError(response.status); }
    // Do not echo service bodies into logs: errors can contain request data.
    const bytes = await this.readBytes(response, 4 * 1024 * 1024);
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("Mozilla returned malformed JSON; inspect the AMO Developer Hub"); }
  }

  async doFormDataPatch(data, addonId, versionId) {
    const form = new FormData();
    for (const [key, value] of Object.entries(data)) form.set(key, value);
    const url = new URL(`addons/addon/${encodeURIComponent(addonId)}/versions/${versionId}/`, baseUrl);
    const response = await this.fetch(url, "PATCH", form);
    await response.body?.cancel();
    if (!response.ok) throw new ApiError(response.status);
  }

  async attachLicense(addonId, versionId, name, text) {
    return this.fetchJson(new URL(`addons/addon/${encodeURIComponent(addonId)}/versions/${versionId}/`, baseUrl),
      "PATCH", JSON.stringify({ custom_license: { name: { "en-US": name }, text: { "en-US": text } } }));
  }

  async readBytes(response, limit) {
    assert(response.body, "Empty Mozilla response body");
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.length;
        assert(bytes <= limit, "Mozilla response exceeds the expected size limit");
        chunks.push(result.value);
      }
      return Buffer.concat(chunks, bytes);
    } finally { await reader.cancel(); }
  }

  async waitRetry(success, url, _interval, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.signal.throwIfAborted();
      assert(Date.now() < deadline, "Mozilla validation timed out; rerun the release to reconcile its state");
      const result = success(await this.fetchJson(url));
      if (result) return result;
      await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())), undefined, { signal: this.signal });
    }
  }

  async version(id, version) {
    const url = new URL(`addons/addon/${encodeURIComponent(id)}/versions/v${version}/`, baseUrl);
    try { return await this.fetchJson(url); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  }

  // Owner-only list of every non-deleted listed version. Pagination links are
  // followed only through nodeFetch's fixed AMO API destination check.
  async listedVersions(id, maximumPages = 20) {
    let url = new URL(`addons/addon/${encodeURIComponent(id)}/versions/?filter=all_without_unlisted&page_size=50`, baseUrl);
    const versions = [];
    for (let page = 0; page < maximumPages; page++) {
      const result = await this.fetchJson(url);
      assert(Array.isArray(result?.results), "Unexpected AMO version listing");
      versions.push(...result.results);
      if (result.next === null || result.next === undefined) return versions;
      assert(typeof result.next === "string", "Unexpected AMO version pagination");
      url = new URL(result.next);
    }
    throw new Error(`AMO version listing exceeds ${maximumPages} pages; inspect the Developer Hub`);
  }

  async download(url, limit = maximumDownload) {
    // Downloads may redirect to Mozilla's CDN. Never forward the JWT there.
    for (let redirects = 0; redirects <= 5; redirects++) {
      url = new URL(url);
      assert(downloadOrigins.has(url.origin) && !url.username && !url.password && !url.hash, "Unexpected Mozilla download destination");
      const headers = url.origin === origin ? { Authorization: await this.apiAuth.getAuthHeader() } : {};
      const response = await this.fetchImpl(url, {
        headers, redirect: "manual", signal: AbortSignal.any([this.signal, AbortSignal.timeout(60_000)]),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        assert(response.headers.has("location"), "Redirect has no destination");
        url = new URL(response.headers.get("location"), url);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new ApiError(response.status); }
      return this.readBytes(response, limit);
    }
    throw new Error("Mozilla download exceeded five redirects");
  }
}

export async function signRelease({ client, context, directory, output, verify = verifyPayload, report = () => {}, beforeWrite = async () => {},
  checkPriorReleases = async () => {}, supersede = "", approvalWaitMs = Infinity }) {
  assert.equal(typeof supersede, "string");
  assert(approvalWaitMs >= 0, "Invalid approval wait");
  // Waiting ends with a resumable pending state; the client signal remains the
  // hard deadline for every request, including work after approval appears.
  const waitUntil = Date.now() + approvalWaitMs;
  const unsigned = `${directory}/unsigned.xpi`;
  const source = `${directory}/source.zip`;
  assert.equal(sha256(await readFile(unsigned)), context.unsigned.sha256);
  assert.equal(sha256(await readFile(source)), context.source.sha256);
  const licenseText = await readFile(`${directory}/license.txt`, "utf8");
  assert.equal(sha256(licenseText), context.license.sha256);
  assert(["listed", "unlisted"].includes(context.channel), "Unsupported Mozilla distribution channel");
  const unlisted = context.channel === "unlisted";
  assert(!unlisted || supersede === "", "Unlisted signing never authorizes superseding a listed version");
  const site = await client.fetchJson(new URL("site/", baseUrl));
  assert.equal(site.read_only, false, "AMO is read-only or its state is unavailable; retry after maintenance");
  if (site.submit_notification_warning) report({ notice: String(site.submit_notification_warning) });
  const addonUrl = new URL(`addons/addon/${encodeURIComponent(context.id)}/`, baseUrl);
  const checkListing = async () => {
    const addon = await client.fetchJson(addonUrl);
    assert.equal(addon.guid, context.id, "The existing AMO add-on must match the manifest ID");
    assert.equal(addon.slug, "stackma", "Unexpected AMO listing");
    assert.equal(addon.is_disabled, false, "AMO listing is disabled or its state is unavailable");
    assert((unlisted ? ["public", "nominated", "incomplete"] : ["public", "nominated"]).includes(addon.status),
      "AMO listing needs attention in the Developer Hub");
    return addon;
  };
  await checkListing();
  let version = await client.version(context.id, context.version);
  if (!version) {
    // Only creation disables other pending versions; resuming never does.
    // Check before the upload and again immediately before creation.
    const requireSubmissionAllowed = async () => {
      // Unlisted creation neither disables listed files nor inherits their
      // license. The scoped unlisted caller supplies its reviewed authority;
      // the listed admission/supersession barrier remains unchanged below.
      if (unlisted) return;
      const versions = await client.listedVersions(context.id);
      const pending = pendingVersions(versions, context.version);
      if (pending.length === 1 && pending[0] === supersede) {
        report({ notice: `Replacing AMO version ${supersede}, which awaits review, as explicitly requested` });
      } else if (pending.length > 0) {
        throw new PendingReviewError(pending, context.version);
      }
      await checkPriorReleases(versions);
      // Deployed v5 orders this owner list by newest creation. Inheritance uses
      // that same nondeleted listed history, including disabled/pending files,
      // rather than the add-on's current public version. Single-writer operation
      // is essential: AMO has no expected-predecessor condition on creation.
      const predecessor = versions[0];
      assert(predecessor?.file && Number.isSafeInteger(predecessor.id) && predecessor.id > 0,
        "Cannot establish the AMO license predecessor; inspect the Developer Hub");
      const previous = await client.version(context.id, predecessor.version);
      assert(previous?.id === predecessor.id && previous.channel === "listed", "AMO license predecessor changed");
      assert(matchesAmoLicense(previous.license?.text?.["en-US"], context.license.sha256),
        "Latest listed AMO version has different license terms; source-on-create requires the existing WTFPL and CMU terms. Do not change license metadata automatically.");
    };
    // The tag check keeps its original precedence and still runs right before
    // each write; the pending check sits between the two tag checks.
    await beforeWrite();
    await requireSubmissionAllowed();
    await beforeWrite();
    report({ state: "validating-upload" });
    const uuid = await client.doUploadSubmit(unsigned, context.channel);
    // Reconcile again after potentially slow validation, before creating a version.
    version = await client.version(context.id, context.version);
    if (!version) {
      await checkListing();
      await beforeWrite();
      await requireSubmissionAllowed();
      await beforeWrite();
      report({ state: "submitting-version", upload: uuid });
      // No automatic retries of a mutating request. A lost response is ambiguous;
      // the next run starts with GET and resumes an accepted version.
      await client.doVersionSubmit(context.id, uuid, source);
      version = await client.version(context.id, context.version);
      assert(version, "Created version is not yet visible; rerun to reconcile");
      assert(version.source, "Created version has no source attachment; stop and inspect the accepted submission");
    }
  }
  let verifiedFileHash;
  let verifiedSourceUrl;
  let verifiedBytes;
  const versionId = version.id;
  const checkVersion = version => {
    assert.equal(version.version, context.version, "AMO version mismatch");
    assert.equal(version.channel, context.channel, "AMO channel mismatch");
    assert.equal(version.is_disabled, false, "AMO version is disabled or its state is unavailable");
    assert((unlisted && version.license === null) || matchesAmoLicense(version.license?.text?.["en-US"], context.license.sha256),
      "AMO license differs from the expected text or link destinations; do not rewrite existing version metadata");
    assert(Number.isSafeInteger(version.id) && version.id > 0, "Invalid AMO version ID");
    assert.equal(version.id, versionId, "AMO version identity changed during reconciliation");
    assert(version.file && ["unreviewed", "public"].includes(version.file.status), "AMO version is disabled, rejected or in an unsupported state; inspect the Developer Hub");
    assert.match(version.file.hash, /^sha256:[a-f0-9]{64}$/u);
    assert(Number.isSafeInteger(version.file.size) && version.file.size > 0 && version.file.size <= maximumDownload);
    assert(version.source === null || (typeof version.source === "string" && version.source.length > 0), "AMO source metadata is unavailable");
  };
  for (;;) {
    client.signal.throwIfAborted();
    checkVersion(version);
    if (verifiedFileHash !== version.file.hash || verifiedBytes !== version.file.size) {
      const bytes = await client.download(version.file.url);
      // Signing can replace the archive between the metadata and file requests.
      // Retry only reads on that race, within the same total deadline.
      if (bytes.length !== version.file.size || `sha256:${sha256(bytes)}` !== version.file.hash) {
        await delay(client.pollMs, undefined, { signal: client.signal });
        version = await client.version(context.id, context.version);
        assert(version, "AMO version disappeared");
        continue;
      }
      await writeFile(output, bytes);
      await verify(unsigned, output, { signal: client.signal });
      verifiedFileHash = version.file.hash;
      verifiedBytes = bytes.length;
    }
    const approved = version.file.status === "public" && ((await checkListing()).status === "public" || unlisted);
    if (version.source) {
      // Source URLs can stay the same when manually replaced. Recheck at final
      // approval, while avoiding whole-archive transfers on every pending poll.
      if (verifiedSourceUrl !== version.source || approved) {
        assert.equal(sha256(await client.download(version.source)), context.source.sha256, "AMO source differs; never overwrite an observed conflicting source archive");
        verifiedSourceUrl = version.source;
      }
    } else {
      await checkListing();
      await beforeWrite();
      const latest = await client.version(context.id, context.version);
      assert(latest, "AMO version disappeared before source attachment");
      checkVersion(latest);
      assert.equal(latest.id, version.id, "AMO version identity changed");
      if (latest.source || latest.file.hash !== verifiedFileHash || latest.file.size !== verifiedBytes) { version = latest; continue; }
      // AMO has no conditional-if-empty PATCH. Publishers must coordinate with
      // manual Developer Hub edits; the final GET narrows but cannot remove it.
      report({ state: "attaching-source", versionId: version.id });
      await client.doFormDataPatch({ source: client.fileFromSync(source) }, context.id, version.id);
      // Read back the attachment instead of treating a successful PATCH as proof.
      version = await client.version(context.id, context.version);
      assert(version?.source, "Source attachment is not visible; rerun to reconcile");
      continue;
    }
    if (unlisted && version.license === null) {
      // AMO only inherits licenses for listed versions. Attach the exact terms
      // to a verified unlisted payload/source before allowing distribution.
      // This creates a new license; it never edits the listed channel's terms.
      await beforeWrite();
      const latest = await client.version(context.id, context.version);
      assert(latest, "AMO version disappeared before license attachment");
      checkVersion(latest);
      if (latest.license !== null || latest.source !== version.source || latest.file.hash !== verifiedFileHash || latest.file.size !== verifiedBytes) {
        version = latest; continue;
      }
      await beforeWrite();
      await client.attachLicense(context.id, version.id, context.license.name, licenseText);
      version = await client.version(context.id, context.version);
      assert(version?.license, "License attachment is not visible; rerun to reconcile");
      continue;
    }
    report({ state: approved ? "approved-and-signed" : "awaiting-review", versionId: version.id });
    if (approved) return {
      state: "approved-and-signed",
      versionId: version.id,
      signed: { sha256: verifiedFileHash.slice(7), bytes: verifiedBytes },
      // Keep the submitted text identity and the verified API representation
      // distinct. Publication can then recheck the exact observed representation.
      license: { ...context.license, apiSha256: sha256(version.license.text["en-US"]) },
    };
    // Reached only with a matching payload, license and attached source. A
    // later run resumes this version without another upload or creation.
    if (Date.now() >= waitUntil) return { state: "awaiting-review", versionId: version.id, fileStatus: version.file.status };
    await delay(client.pollMs, undefined, { signal: client.signal });
    version = await client.version(context.id, context.version);
    assert(version, "AMO version disappeared");
  }
}
