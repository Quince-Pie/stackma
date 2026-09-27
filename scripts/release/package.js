import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

export const run = promisify(execFile);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Branding belongs to the frozen product source. Keep legacy records byte-
// compatible by adding fields only for the renamed product, never to old tags.
export function brandMetadata(manifest) {
  return manifest.name === "Tab Gantry" ? { displayName: "Tab Gantry", artifactPrefix: "tab-gantry" } : {};
}

export function releaseBrand(record) {
  if (record.displayName === undefined && record.artifactPrefix === undefined) {
    return { displayName: "Stackma", artifactPrefix: "stackma" };
  }
  assert.equal(record.displayName, "Tab Gantry", "Unexpected release display name");
  assert.equal(record.artifactPrefix, "tab-gantry", "Unexpected release artifact prefix");
  return { displayName: record.displayName, artifactPrefix: record.artifactPrefix };
}

export function artifactNames(record) {
  const { artifactPrefix } = releaseBrand(record);
  return { xpi: `${artifactPrefix}-${record.version}.xpi`, source: `${artifactPrefix}-${record.version}-source.zip` };
}

// AMO's normalize task writes json.dumps(..., indent=2): ASCII-escaped JSON,
// two-space indentation and no trailing newline. Keep our manifest in that
// representation before packaging, so its bytes survive upload normalization.
export function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2).replace(/[\u007f-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function versionFromTag(tag) {
  assert.equal(tag.trim(), tag, "Whitespace is not permitted in a release tag");
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, "Use a stable vMAJOR.MINOR.PATCH version, for example v1.1.1");
  const version = tag.slice(1);
  assert(version.split(".").every(part => Number(part) <= 999_999_999), "AMO version components must contain at most nine digits");
  return version;
}

export function compareReleaseTags(a, b) {
  const left = versionFromTag(a).split(".").map(Number);
  const right = versionFromTag(b).split(".").map(Number);
  const index = left.findIndex((part, i) => part !== right[i]);
  return index === -1 ? 0 : left[index] - right[index];
}

export class VersionMismatchError extends Error {
  constructor(tag, expected, declared) {
    super(`Tag, manifest and npm versions must agree. ${tag} requires ${expected}.\n` +
      Object.entries(declared).map(([field, actual]) => `${field}: ${JSON.stringify(actual)}`).join("\n"));
    this.name = "VersionMismatchError";
  }
}

export function validateMetadata(tag, manifest, pkg, lock) {
  const version = versionFromTag(tag);
  const declared = {
    "extension/manifest.json version": manifest.version,
    "package.json version": pkg.version,
    "package-lock.json version": lock.version,
    'package-lock.json packages[""].version': lock.packages[""].version,
  };
  if (Object.values(declared).some(actual => actual !== version)) {
    throw new VersionMismatchError(tag, version, declared);
  }
  assert.equal(manifest.browser_specific_settings.gecko.id, "stackma@extensions.local");
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "156.0");
  const brand = brandMetadata(manifest);
  if (brand.artifactPrefix) {
    assert.equal(pkg.name, brand.artifactPrefix);
    assert.equal(lock.name, brand.artifactPrefix);
    assert.equal(lock.packages[""].name, brand.artifactPrefix);
  }
  return { version, id: manifest.browser_specific_settings.gecko.id, ...brand };
}

export async function digestFile(path) {
  return { bytes: (await stat(path)).size, sha256: sha256(await readFile(path)) };
}
