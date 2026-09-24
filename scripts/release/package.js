import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

export const run = promisify(execFile);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function versionFromTag(tag) {
  assert.equal(tag.trim(), tag, "Whitespace is not permitted in a release tag");
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, "Use a stable vMAJOR.MINOR.PATCH version, for example v1.1.1");
  const version = tag.slice(1);
  assert(version.split(".").every(part => Number(part) <= 999_999_999), "AMO version components must contain at most nine digits");
  return version;
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
  return { version, id: manifest.browser_specific_settings.gecko.id };
}

export async function digestFile(path) {
  return { bytes: (await stat(path)).size, sha256: sha256(await readFile(path)) };
}
