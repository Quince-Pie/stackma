import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { serializeManifest } from "../../scripts/release/package.js";
import { bumpVersions } from "../../scripts/release/prepare.js";

test("manifest serialization matches AMO's captured normalization without changing values", async () => {
  const normalized = await readFile("tests/release/fixtures/amo-manifest-1.1.2.json", "utf8");
  const manifest = JSON.parse(normalized);
  assert.equal(serializeManifest(manifest), normalized);
  assert.deepEqual(JSON.parse(serializeManifest(manifest)), manifest);
  assert(!normalized.endsWith("\n"));
});

test("manifest encoding preserves BMP, supplementary Unicode, controls and literal escapes", () => {
  const manifest = { text: "© — ’ 中文 😀\u007f\n\\u2019", manifest_version: 3 };
  const encoded = serializeManifest(manifest);
  assert.match(encoded, /\\ud83d\\ude00/u);
  assert.match(encoded, /\\u007f/u);
  assert(!/[\u007f-\uffff]/u.test(encoded));
  assert.deepEqual(JSON.parse(encoded), manifest);
});

test("new release preparation preserves the manifest's AMO encoding", async () => {
  const documents = await Promise.all(["extension/manifest.json", "package.json", "package-lock.json"].map(async path => JSON.parse(await readFile(path, "utf8"))));
  for (const document of documents) document.version = "1.0.0";
  documents[2].packages[""].version = "1.0.0";
  const inputs = documents.map(document => JSON.stringify(document));
  const [manifestText, pkgText, lockText] = bumpVersions("v1.0.1", inputs);
  assert(!manifestText.endsWith("\n"));
  assert(!/[\u007f-\uffff]/u.test(manifestText));
  const manifest = JSON.parse(manifestText), before = JSON.parse(inputs[0]);
  assert.deepEqual(manifest, { ...before, version: "1.0.1" });
  assert.equal(JSON.parse(pkgText).version, "1.0.1");
  assert.equal(JSON.parse(lockText).packages[""].version, "1.0.1");
});
