import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import Client, { JwtApiAuth } from "web-ext/util/submit-addon";
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

/** Reuse Mozilla's request construction, with bounded transport and polling. */
export class ReleaseClient extends Client {
  constructor({ apiKey, apiSecret, timeoutMs = 20 * 60_000, fetchImpl = fetch, pollMs = 5_000 }) {
    super({ baseUrl, apiAuth: new JwtApiAuth({ apiKey, apiSecret }), userAgentString: "stackma-release/1" });
    this.signal = AbortSignal.timeout(timeoutMs);
    this.fetchImpl = fetchImpl;
    this.pollMs = pollMs;
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
    return JSON.parse((await this.readBytes(response, 4 * 1024 * 1024)).toString("utf8"));
  }

  async doFormDataPatch(data, addonId, versionId) {
    const form = new FormData();
    for (const [key, value] of Object.entries(data)) form.set(key, value);
    const url = new URL(`addons/addon/${encodeURIComponent(addonId)}/versions/${versionId}/`, baseUrl);
    const response = await this.fetch(url, "PATCH", form);
    await response.body?.cancel();
    if (!response.ok) throw new ApiError(response.status);
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

export async function signRelease({ client, context, directory, output, verify = verifyPayload, report = () => {}, beforeWrite = async () => {} }) {
  const unsigned = `${directory}/unsigned.xpi`;
  const source = `${directory}/source.zip`;
  assert.equal(sha256(await readFile(unsigned)), context.unsigned.sha256);
  assert.equal(sha256(await readFile(source)), context.source.sha256);
  const licenseText = await readFile(`${directory}/license.txt`, "utf8");
  assert.equal(sha256(licenseText), context.license.sha256);
  const site = await client.fetchJson(new URL("site/", baseUrl));
  assert(!site.read_only, "AMO is read-only; retry after maintenance");
  if (site.submit_notification_warning) report({ notice: String(site.submit_notification_warning) });
  const addonUrl = new URL(`addons/addon/${encodeURIComponent(context.id)}/`, baseUrl);
  const checkListing = async () => {
    const addon = await client.fetchJson(addonUrl);
    assert.equal(addon.guid, context.id, "The existing AMO add-on must match the manifest ID");
    assert.equal(addon.slug, "stackma", "Unexpected AMO listing");
    assert.equal(addon.is_disabled, false, "AMO listing is disabled or its state is unavailable");
    assert(["public", "nominated"].includes(addon.status), "AMO listing needs attention in the Developer Hub");
    return addon;
  };
  await checkListing();
  assert.equal(context.channel, "listed");
  let version = await client.version(context.id, context.version);
  if (!version) {
    await beforeWrite();
    report({ state: "validating-upload" });
    const uuid = await client.doUploadSubmit(unsigned, "listed");
    // Reconcile again after potentially slow validation, before creating a version.
    version = await client.version(context.id, context.version);
    if (!version) {
      await checkListing();
      await beforeWrite();
      report({ state: "submitting-version", upload: uuid });
      // No automatic retries of a mutating request. A lost response is ambiguous;
      // the next run starts with GET and resumes an accepted version.
      await client.doNewAddonOrVersionSubmit(context.id, uuid, { version: { custom_license: {
        name: { "en-US": context.license.name }, text: { "en-US": licenseText },
      } } });
      version = await client.version(context.id, context.version);
      assert(version, "Created version is not yet visible; rerun to reconcile");
    }
  }
  let verifiedFileHash;
  let verifiedSourceUrl;
  let verifiedBytes;
  const checkVersion = version => {
    assert.equal(version.version, context.version, "AMO version mismatch");
    assert.equal(version.channel, "listed", "AMO channel mismatch");
    assert.equal(version.is_disabled, false, "AMO version is disabled or its state is unavailable");
    assert(matchesAmoLicense(version.license?.text?.["en-US"], context.license.sha256),
      "AMO license differs from the expected text or link destinations; do not rewrite existing version metadata");
    assert(Number.isSafeInteger(version.id) && version.id > 0, "Invalid AMO version ID");
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
    const approved = version.file.status === "public" && (await checkListing()).status === "public";
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
    report({ state: approved ? "approved-and-signed" : "awaiting-review", versionId: version.id });
    if (approved) return {
      versionId: version.id,
      signed: { sha256: verifiedFileHash.slice(7), bytes: verifiedBytes },
      // Keep the submitted text identity and the verified API representation
      // distinct. Publication can then recheck the exact observed representation.
      license: { ...context.license, apiSha256: sha256(version.license.text["en-US"]) },
    };
    await delay(client.pollMs, undefined, { signal: client.signal });
    version = await client.version(context.id, context.version);
    assert(version, "AMO version disappeared");
  }
}
