import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { digestFile, run, sha256, versionFromTag } from "./package.js";

export class GitHub {
  constructor(repository, token, fetchImpl = fetch) {
    assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    assert(token, "Missing GitHub release token");
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  async get(path) {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}/${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return null;
      throw new Error(`GitHub API returned HTTP ${response.status}`);
    }
    return response.json();
  }
  cli(args) {
    // No shell interpretation, credentials only in the explicitly scoped step
    // environment, and finite child lifetime even if the service stalls.
    return run("gh", [...args, "--repo", this.repository], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  }
  async mutate(releaseId, { file, name, body }) {
    assert(Number.isSafeInteger(releaseId) && releaseId > 0, "Invalid release identity");
    const upload = file !== undefined;
    const url = upload
      ? `https://uploads.github.com/repos/${this.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
      : `https://api.github.com/repos/${this.repository}/releases/${releaseId}`;
    const response = await this.fetchImpl(url, {
      method: upload ? "POST" : "PATCH",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": upload ? "application/octet-stream" : "application/json" },
      body: upload ? await readFile(file) : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), redirect: "error",
    });
    await response.body?.cancel();
    assert(response.ok, `GitHub mutation returned HTTP ${response.status}; rerun to reconcile its outcome`);
  }
  async releases() {
    const releases = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.get(`releases?per_page=100&page=${page}`);
      assert(Array.isArray(result), "Cannot establish release history");
      releases.push(...result);
      if (result.length < 100) return releases;
    }
    throw new Error("Release history reaches the 10,000-entry recovery bound; inspect and reconcile existing remote state");
  }
  async commit(tag) {
    let ref = await this.get(`git/ref/tags/${tag}`);
    assert(ref, "Release tag must already exist remotely");
    let object = ref.object;
    for (let depth = 0; object.type === "tag" && depth < 16; depth++) {
      assert.match(object.sha, /^[a-f0-9]{40}$/u);
      ref = await this.get(`git/tags/${object.sha}`);
      assert(ref, "Annotated tag disappeared");
      object = ref.object;
    }
    assert.equal(object.type, "commit", "Tag must resolve to a commit");
    assert.match(object.sha, /^[a-f0-9]{40}$/u);
    return object.sha;
  }
}

export async function checkAmoPublication(record, fetchImpl = fetch) {
  assert.equal(record.id, "stackma@extensions.local");
  assert.equal(record.channel, "listed");
  const base = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(record.id)}/`;
  const get = async url => {
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`AMO is not publicly available (HTTP ${response.status})`);
    }
    return response.json();
  };
  const [addon, version] = await Promise.all([get(base), get(`${base}versions/v${record.version}/`)]);
  assert.equal(addon.guid, record.id);
  assert.equal(addon.status, "public", "AMO listing is not approved");
  assert.equal(addon.is_disabled, false, "AMO listing is disabled");
  assert.equal(version.id, record.versionId);
  assert.equal(version.version, record.version);
  assert.equal(version.channel, "listed");
  // The public serializer omits the owner-only is_disabled field. Anonymous
  // detail access plus public file status excludes developer-disabled versions.
  assert.equal(version.file.status, "public", "AMO version is not approved");
  assert.equal(version.file.hash, `sha256:${record.signed.sha256}`, "AMO file changed since verification");
  assert.equal(version.file.size, record.signed.bytes);
  assert.equal(typeof version.license?.text?.["en-US"], "string", "AMO license metadata is unavailable");
  assert.match(record.license.apiSha256, /^[a-f0-9]{64}$/u, "Missing verified AMO license representation");
  assert.equal(sha256(version.license.text["en-US"]), record.license.apiSha256, "AMO license changed since verification");
}

export function matchingRelease(releases, tag, marker) {
  const matches = releases.filter(release => release.tag_name === tag);
  assert(matches.length <= 1, "Multiple releases use this tag; resolve duplicate drafts explicitly");
  const release = matches[0];
  if (release) {
    assert(release.body?.startsWith(marker), "Existing release belongs to a different build; never adopt or overwrite it");
    assert(!release.prerelease, "Stable release unexpectedly marked prerelease");
  }
  return release;
}

export function verifyAssets(release, files, { complete = false } = {}) {
  const seen = new Set();
  for (const asset of release.assets) {
    assert(!seen.has(asset.name), "Duplicate release asset");
    seen.add(asset.name);
    const expected = files[asset.name];
    assert(expected, `Unexpected release asset ${JSON.stringify(asset.name)}`);
    assert.equal(asset.state, "uploaded", "Incomplete upload; inspect the draft asset before retrying");
    assert.equal(asset.size, expected.bytes, `Asset size conflict: ${asset.name}`);
    assert.equal(asset.digest, `sha256:${expected.sha256}`, `Asset digest conflict: ${asset.name}`);
  }
  if (complete) assert.deepEqual([...seen].sort(), Object.keys(files).sort(), "Missing release assets");
  return seen;
}

export async function publishRelease({ github, record, directory, notesPath, verificationAttempts = 4, pause = delay, amoCheck = checkAmoPublication }) {
  const { tag, version, commit } = record;
  assert.equal(versionFromTag(tag), version);
  assert.match(commit, /^[a-f0-9]{40}$/u);
  const names = [`stackma-${version}.xpi`, `stackma-${version}-source.zip`, "release.json", "SHA256SUMS"];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await digestFile(`${directory}/${name}`)])));
  assert.deepEqual(files[names[0]], record.signed);
  assert.deepEqual(files[names[1]], record.source);
  const expectedSums = names.slice(0, 3).map(name => `${files[name].sha256}  ${name}\n`).join("");
  assert.equal(await readFile(`${directory}/SHA256SUMS`, "utf8"), expectedSums);
  const marker = `<!-- stackma-release:${tag}:${commit}:${record.unsigned.sha256}:${record.source.sha256} -->`;
  assert.equal(await github.commit(tag), commit, "Remote tag moved since verification");
  await amoCheck(record);
  let history = await github.releases();
  let release = matchingRelease(history, tag, marker);
  if (!release) {
    await writeFile(notesPath, `${marker}\n\nMozilla-signed Stackma ${version} for Firefox 156 and newer.\n\nInstall from [Mozilla Add-ons](https://addons.mozilla.org/firefox/addon/stackma/) for normal automatic updates, or download the XPI and use Firefox's Add-ons Manager → Install Add-on From File.\n\nSource commit: ${commit}. See SHA256SUMS and release.json for package identities and Firefox verification.\n`);
    // Explicit --draft preserves completed uploads if a later operation fails.
    // Never retry a write here; the next run reconciles server state first.
    await github.cli(["release", "create", tag, "--draft", "--verify-tag", "--target", commit,
      "--title", `Stackma ${version}`, "--notes-file", notesPath, "--generate-notes"]);
    history = await github.releases();
    release = matchingRelease(history, tag, marker);
    assert(release, "Created draft is not visible; rerun to reconcile");
  }
  const present = verifyAssets(release, files, { complete: !release.draft });
  const releaseId = release.id;
  assert(Number.isSafeInteger(releaseId) && releaseId > 0, "Invalid release identity");
  if (release.draft) {
    for (const name of names) {
      if (!present.has(name)) await github.mutate(releaseId, { file: `${directory}/${name}`, name });
    }
    history = await github.releases();
    release = matchingRelease(history, tag, marker);
    assert(release?.draft, "Release state changed during upload");
    assert.equal(release.id, releaseId, "Release identity changed during upload");
    verifyAssets(release, files, { complete: true });
    assert.equal(await github.commit(tag), commit, "Remote tag moved before publication");
    await amoCheck(record);
    const parts = version.split(".").map(Number);
    const newer = history.some(other => {
      if (other.draft || other.prerelease) return false;
      if (!/^v\d+\.\d+\.\d+$/u.test(other.tag_name)) return true; // Do not displace an unknown latest policy.
      const candidate = other.tag_name.slice(1).split(".").map(Number);
      for (let i = 0; i < 3; i++) if (candidate[i] !== parts[i]) return candidate[i] > parts[i];
      return false;
    });
    await github.mutate(releaseId, { body: { tag_name: tag, draft: false, make_latest: String(!newer) } });
  }
  // Publishing and attestation are not a transaction. If this gate fails, keep
  // the published release and report failure; never delete or replace it.
  release = matchingRelease(await github.releases(), tag, marker);
  assert(release && !release.draft && release.immutable, "Published release is not immutable; enable immutable releases in repository settings before the first release");
  assert.equal(release.id, releaseId, "Published release identity changed");
  verifyAssets(release, files, { complete: true });
  assert.equal(await github.commit(tag), commit, "Published tag differs from tested commit");
  for (let attempt = 0; ; attempt++) {
    try {
      for (const name of names) await github.cli(["release", "verify-asset", tag, `${directory}/${name}`]);
      return { tag, commit, url: release.html_url, immutable: true, files };
    } catch (error) {
      if (attempt + 1 === verificationAttempts) throw error;
      await pause(15_000);
    }
  }
}
