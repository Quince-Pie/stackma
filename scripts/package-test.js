import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FirefoxDriver } from "./webdriver.js";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const signed = process.argv.includes("--signed");
const path = process.argv.find(arg => arg.startsWith("--xpi="))?.slice("--xpi=".length) ?? `dist/stackma-${manifest.version}.xpi`;
const output = resolve(process.argv.find(arg => arg.startsWith("--output="))?.slice("--output=".length) ?? "evidence/package.json");
await mkdir(dirname(output), { recursive: true });
const files = (await readdir("extension")).sort();
const expected = {};
for (const file of files) expected[file] = createHash("sha256").update(await readFile(`extension/${file}`)).digest("hex");
let driver;
try {
  driver = await FirefoxDriver.start({ prefs: { "xpinstall.signatures.required": true } });
  const id = await driver.installAddon(path, { temporary: !signed });
  if (signed) {
    const signature = await driver.chrome(async addonId => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(addonId);
      return {
        signed: addon.signedState === AddonManager.SIGNEDSTATE_SIGNED,
        temporary: addon.temporarilyInstalled, active: addon.isActive,
      };
    }, id);
    assert.deepEqual(signature, { signed: true, temporary: false, active: true }, "Mozilla signature and permanent installation are required");
  }
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
    checks: [signed ? "permanent XPI installation with verified Mozilla signature" : "temporary XPI installation", "every packaged source file matches", "real opener grouping", "native approved name assignment"],
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Packaged extension passed: ${report.bytes} bytes, SHA-256 ${digest}`);
} catch (error) {
  await writeFile(output, JSON.stringify({ passed: false, path, error: String(error) }, null, 2) + "\n");
  // start() cleans up internally before rejecting, so no driver is assigned
  // on that path. Preserve its captured process log for hosted-runner diagnosis.
  if (error && typeof error === "object" && "driverLog" in error && typeof error.driverLog === "string") {
    await writeFile(`${output}.log`, error.driverLog);
  }
  throw error;
} finally {
  if (driver) {
    await driver.close();
    await writeFile(`${output}.log`, driver.logs);
  }
}
