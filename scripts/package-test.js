import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { FirefoxDriver } from "./webdriver.js";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const path = `dist/stackma-${manifest.version}.xpi`;
const files = (await readdir("extension")).sort();
const expected = {};
for (const file of files) expected[file] = createHash("sha256").update(await readFile(`extension/${file}`)).digest("hex");
const driver = await FirefoxDriver.start();
try {
  const id = await driver.installAddon(path);
  const result = await driver.addon(id, async (browser, files) => {
    const actual = {};
    for (const file of files) {
      const response = await fetch(browser.runtime.getURL(file));
      if (!response.ok) throw new Error(`Cannot read packaged ${file}`);
      const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
      actual[file] = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    }
    const source = await browser.tabs.create({ active: false });
    const child = await browser.tabs.create({ openerTabId: source.id, windowId: source.windowId, active: false });
    for (let attempt = 0; attempt < 200; attempt++) {
      const [a, b] = await Promise.all([browser.tabs.get(source.id), browser.tabs.get(child.id)]);
      if (a.groupId >= 0 && a.groupId === b.groupId) {
        const group = await browser.tabGroups.get(a.groupId);
        if (group.title) return { actual, manifest: browser.runtime.getManifest(), name: group.title };
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Packaged extension did not group a related tab");
  }, files);
  assert.deepEqual(result.actual, expected);
  assert.deepEqual(result.manifest.permissions, ["webNavigation", "tabGroups", "storage"]);
  const pack = JSON.parse(await readFile("naming-data/en-v1.json", "utf8"));
  assert(pack.pairs.some(pair => `${pair.adjective}-${pair.noun}` === result.name));
  const archive = await readFile(path);
  const digest = createHash("sha256").update(archive).digest("hex");
  const report = {
    passed: true, path, bytes: (await stat(path)).size, sha256: digest,
    firefox: driver.capabilities.browserVersion,
    buildId: driver.capabilities["moz:buildID"], files: expected,
    checks: ["temporary XPI installation", "every packaged source file matches", "real opener grouping", "native approved name assignment"],
  };
  await writeFile("evidence/package.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`Packaged extension passed: ${report.bytes} bytes, SHA-256 ${digest}`);
} finally {
  await driver.close();
}
