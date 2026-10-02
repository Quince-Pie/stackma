import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { serializeManifest } from "./release/package.js";

// extension/ is Firefox's directly loadable package. Chrome shares every file
// except Firefox's manifest and event-page entry, and adds chrome/extension/.
export const firefoxOnly = new Set(["manifest.json", "background.js"]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/**
 * Chrome's version rules: one to four dot-separated integers from 0 to 65535,
 * no leading zeros, not all zero (developer.chrome.com/docs/extensions/
 * reference/manifest/version). Mozilla permits larger components.
 * @param {unknown} version
 */
export function chromeVersion(version) {
  assert(typeof version === "string" && /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/u.test(version),
    `Chrome requires one to four dot-separated integers without leading zeros; got ${JSON.stringify(version)}`);
  const parts = version.split(".").map(Number);
  assert(parts.every(part => part <= 65_535), `Chrome version components must not exceed 65535; got ${version}`);
  assert(parts.some(part => part > 0), "A Chrome version cannot be all zeros");
  return version;
}

/** Derive the Chrome manifest; shared product fields must equal Firefox's. */
export function chromeManifest(firefox, template) {
  assert.equal(template.manifest_version, 3);
  assert(!Object.hasOwn(template, "version"), "chrome/manifest.json takes its version from extension/manifest.json");
  assert(!Object.hasOwn(template, "browser_specific_settings"));
  assert.deepEqual(template.permissions, firefox.permissions, "Chrome and Firefox manifests differ in permissions");
  // The Chrome Web Store takes its listing title from the manifest name, while
  // AMO's is edited separately. Chrome may append a descriptor, never rebrand.
  assert(template.name === firefox.name || (typeof template.name === "string" && template.name.startsWith(`${firefox.name} - `)),
    `Chrome and Firefox manifests differ in name; Chrome may only append " - <descriptor>" to ${JSON.stringify(firefox.name)}`);
  for (const field of ["default_title", "default_popup"]) {
    assert.equal(template.action?.[field], firefox.action?.[field], `Chrome and Firefox manifests differ in action.${field}`);
  }
  assert.match(template.minimum_chrome_version ?? "", /^[1-9]\d*$/u, "Declare minimum_chrome_version as a major version");
  assert.deepEqual(template.background, { service_worker: template.background?.service_worker, type: "module" });
  // Documented limits: name 75 characters, description 132 characters.
  assert(typeof template.name === "string" && template.name.length <= 75, "Chrome extension names are limited to 75 characters");
  assert(typeof template.description === "string" && template.description.length <= 132, "Chrome descriptions are limited to 132 characters");
  const { manifest_version, name, ...rest } = template;
  return { manifest_version, name, version: chromeVersion(firefox.version), ...rest };
}

function pngSize(bytes) {
  assert(bytes.length >= 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
    bytes.subarray(12, 16).toString("latin1") === "IHDR", "Chrome icons must be PNG files");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The complete Chrome package: sorted entries with a source path or content. */
export async function chromePackage(root = ".") {
  const firefox = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
  const template = JSON.parse(await readFile(join(root, "chrome/manifest.json"), "utf8"));
  const manifest = chromeManifest(firefox, template);
  const list = async directory => (await readdir(join(root, directory), { withFileTypes: true })).map(entry => {
    assert(entry.isFile(), `Unexpected package entry: ${directory}/${entry.name}`);
    return entry.name;
  });
  const entries = new Map([["manifest.json", { name: "manifest.json", content: serializeManifest(manifest) }]]);
  for (const [directory, names] of [["extension", (await list("extension")).filter(name => !firefoxOnly.has(name))],
    ["chrome/extension", await list("chrome/extension")]]) {
    for (const name of names) {
      assert(!entries.has(name), `Chrome package file ${name} exists in both extension/ and chrome/extension/`);
      entries.set(name, { name, path: join(root, directory, name) });
    }
  }
  const references = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon), ...Object.values(manifest.icons)];
  for (const name of references) assert(entries.has(name), `Chrome manifest references missing file ${name}`);
  // Icons are rendered, then committed; reject artwork older than the SVG.
  const record = JSON.parse(await readFile(join(root, "chrome/icons.json"), "utf8"));
  assert.equal(record.sourceSha256, sha256(await readFile(join(root, "extension/icon.svg"))),
    "Chrome icons were rendered from a different extension/icon.svg; run node scripts/render-chrome-icons.js");
  for (const [size, name] of [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)]) {
    const bytes = await readFile(/** @type {string} */ (entries.get(name).path));
    assert.deepEqual(pngSize(bytes), { width: Number(size), height: Number(size) }, `${name} must be ${size}x${size}`);
    assert.equal(sha256(bytes), record.files[name]?.sha256, `${name} differs from its render record`);
  }
  return { manifest, entries: [...entries.values()].sort((a, b) => a.name < b.name ? -1 : 1) };
}
