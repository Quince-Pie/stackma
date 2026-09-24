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
  assert(version.split(".").every(part => Number(part) <= 65535), "Firefox version components must fit 16 bits");
  return version;
}

export function validateMetadata(tag, manifest, pkg, lock) {
  const version = versionFromTag(tag);
  for (const actual of [manifest.version, pkg.version, lock.version, lock.packages[""].version]) {
    assert.equal(actual, version, "Tag, manifest and npm versions must agree");
  }
  assert.equal(manifest.browser_specific_settings.gecko.id, "stackma@extensions.local");
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "156.0");
  return { version, id: manifest.browser_specific_settings.gecko.id };
}

export async function digestFile(path) {
  return { bytes: (await stat(path)).size, sha256: sha256(await readFile(path)) };
}
