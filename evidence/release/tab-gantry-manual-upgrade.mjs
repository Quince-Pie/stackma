// Scoped manual rebrand acceptance; this is not an AMO update-delivery test.
import { FirefoxDriver } from "../../scripts/webdriver.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const id = "stackma@extensions.local";
const from = { version: "1.1.6", name: "Stackma" };
const to = { version: "1.1.8", name: "Tab Gantry" };
const maximumBytes = 200_000_000;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function parseArguments(args) {
  const values = {};
  for (const arg of args) {
    const match = /^--(old-xpi|new-xpi|new-sha256|output)=(.+)$/u.exec(arg);
    assert(match && !Object.hasOwn(values, match[1]), "Supply each --name=value argument exactly once");
    values[match[1]] = match[2];
  }
  for (const name of ["old-xpi", "new-xpi", "new-sha256", "output"]) assert(values[name], `Missing --${name}`);
  assert.match(values["new-sha256"], /^[a-f0-9]{64}$/u, "Expected new signed-XPI SHA256 must be 64 lowercase hex characters");
  const options = { oldXpi: resolve(values["old-xpi"]), newXpi: resolve(values["new-xpi"]),
    newSha256: values["new-sha256"], output: resolve(values.output) };
  assert(new Set([options.oldXpi, options.newXpi, options.output, `${options.output}.log`]).size === 4,
    "Input, report and log paths must be distinct");
  return options;
}

// Exclusive scratch output paths are required for the duration of the run.
// Ordinary symlinks are supported; observed inode aliases are rejected before
// any output write. This does not defend against concurrent path replacement.
export async function preflightPaths({ oldXpi, newXpi, output }) {
  const paths = [oldXpi, newXpi, output, `${output}.log`].map(path => resolve(path));
  assert(new Set(paths).size === paths.length, "Input, report and log paths must be distinct");
  const observations = await Promise.all(paths.map(async path => {
    try { return { info: await stat(path, { bigint: true }) }; }
    catch (error) { if (error.code === "ENOENT") return { error }; throw error; }
  }));
  for (let a = 0; a < observations.length; a++) {
    for (let b = a + 1; b < observations.length; b++) {
      const left = observations[a].info, right = observations[b].info;
      assert(!left || !right || left.dev !== right.dev || left.ino !== right.ino,
        "Input, report or log paths alias the same file");
    }
  }
  return observations.slice(0, 2);
}

// Runs inside the real browser's privileged process; captures no Node values.
export async function inspectInstalled(expected) {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const addon = await AddonManager.getAddonByID(expected.id);
  if (!Services.prefs.getBoolPref("xpinstall.signatures.required")) throw new Error("Firefox signature enforcement is disabled");
  if (Services.prefs.getIntPref("network.proxy.type") !== 1 ||
      Services.prefs.getStringPref("network.proxy.http") !== "127.0.0.1" ||
      Services.prefs.getIntPref("network.proxy.http_port") !== 9 ||
      Services.prefs.getStringPref("network.proxy.ssl") !== "127.0.0.1" ||
      Services.prefs.getIntPref("network.proxy.ssl_port") !== 9) throw new Error("Expected isolated Firefox network preferences");
  if (!addon || addon.id !== expected.id || addon.version !== expected.version || addon.name !== expected.name) {
    throw new Error("Installed add-on identity, version or name differs");
  }
  if (addon.signedState !== AddonManager.SIGNEDSTATE_SIGNED || addon.temporarilyInstalled || !addon.isActive) {
    throw new Error("A permanent, active Mozilla-signed installation is required");
  }
  if (addon.updateURL) throw new Error("Unexpected custom add-on update URL");
  const uri = addon.getResourceURI();
  if (uri.scheme !== "jar") throw new Error("Expected a packed signed installation");
  const path = uri.QueryInterface(Ci.nsIJARURI).JARFile.QueryInterface(Ci.nsIFileURL).file.path;
  const info = await IOUtils.stat(path);
  if (info.type !== "regular" || info.size <= 0 || info.size > 200_000_000) throw new Error("Installed archive exceeds expected bounds");
  const bytes = await IOUtils.read(path);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (sha256 !== expected.sha256) throw new Error("Installed signed-XPI bytes differ from the accepted input");
  return { id: addon.id, version: addon.version, name: addon.name, sha256, bytes: bytes.length,
    signed: true, permanent: true, active: true, installDate: addon.installDate.getTime() };
}

export async function runManualUpgrade(options) {
  const { oldXpi, newXpi, newSha256, output } = options;
  assert.match(newSha256, /^[a-f0-9]{64}$/u);
  const inputs = await preflightPaths(options); // failures here must never overwrite either input
  const report = { passed: false, method: "manual signed-XPI replacement in an isolated Firefox profile",
    defaultAmoUpdateDeliveryTested: false, startedAt: new Date().toISOString(), id, from, to, expectedNewSha256: newSha256 };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  let driver, snapshots, exitCleanup, failed = false;
  try {
    for (const input of inputs) {
      if (input.error) throw input.error;
      assert(input.info.isFile() && input.info.size > 0 && input.info.size <= maximumBytes,
        "Signed XPI inputs must be regular nonempty files of at most 200 MB");
    }
    snapshots = await mkdtemp(join(tmpdir(), "tab-gantry-manual-upgrade-"));
    exitCleanup = () => { try { rmSync(snapshots, { recursive: true, force: true }); } catch {} };
    process.once("exit", exitCleanup);
    const oldSnapshot = join(snapshots, "old.xpi"), newSnapshot = join(snapshots, "new.xpi");
    await copyFile(oldXpi, oldSnapshot); await copyFile(newXpi, newSnapshot);
    for (const path of [oldSnapshot, newSnapshot]) {
      const info = await stat(path);
      assert(info.isFile() && info.size > 0 && info.size <= maximumBytes, "Input changed while creating the bounded snapshot");
    }
    const oldDigest = hash(await readFile(oldSnapshot)), newDigest = hash(await readFile(newSnapshot));
    assert.equal(newDigest, newSha256, "New input signed XPI does not match the expected digest");
    report.inputs = { oldSha256: oldDigest, newSha256: newDigest };
    driver = await FirefoxDriver.start({ timeoutMs: 30_000, startupTimeoutMs: 30_000, maxLifetimeMs: 150_000, expectedMajor: 156,
      prefs: { "xpinstall.signatures.required": true, "extensions.update.enabled": false,
        "extensions.update.autoUpdateDefault": false, "app.update.disabledForTesting": true } });
    report.browser = { version: driver.capabilities.browserVersion, buildId: driver.capabilities["moz:buildID"],
      geckodriver: driver.capabilities["moz:geckodriverVersion"] };
    assert.equal(await driver.installAddon(oldSnapshot, { temporary: false }), id);
    report.before = await driver.chrome(inspectInstalled, { id, ...from, sha256: oldDigest });
    const sentinel = randomUUID();
    const fixture = await driver.addon(id, async (browser, sentinel) => {
      const parent = await browser.tabs.create({ active: false });
      const child = await browser.tabs.create({ openerTabId: parent.id, windowId: parent.windowId, active: false });
      let groupId;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [a, b] = await Promise.all([browser.tabs.get(parent.id), browser.tabs.get(child.id)]);
        if (a.groupId >= 0 && a.groupId === b.groupId && (await browser.tabGroups.get(a.groupId)).title) {
          groupId = a.groupId; break;
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      }
      if (groupId === undefined) throw new Error("Older extension did not group and name related tabs");
      await browser.tabGroups.update(groupId, { title: "Retain my research — 日本語", color: "purple", collapsed: true });
      await browser.storage.local.set({ manualUpgradeAcceptance: sentinel });
      return { parent: parent.id, child: child.id, group: await browser.tabGroups.get(groupId) };
    }, sentinel);
    // Deliberate manual installation of the supplied, hashed new XPI. No
    // findUpdates call, custom manifest, or AMO delivery claim is involved.
    assert.equal(await driver.installAddon(newSnapshot, { temporary: false }), id);
    report.after = await driver.chrome(inspectInstalled, { id, ...to, sha256: newSha256 });
    assert.equal(report.after.installDate, report.before.installDate, "Upgrade replaced the installed add-on identity");
    const continuity = await driver.addon(id, async (browser, fixture) => {
      const [parent, child] = await Promise.all([browser.tabs.get(fixture.parent), browser.tabs.get(fixture.child)]);
      return { parentGroup: parent.groupId, childGroup: child.groupId,
        group: await browser.tabGroups.get(parent.groupId),
        storage: (await browser.storage.local.get("manualUpgradeAcceptance")).manualUpgradeAcceptance };
    }, fixture);
    assert.equal(continuity.parentGroup, fixture.group.id); assert.equal(continuity.childGroup, fixture.group.id);
    for (const key of ["id", "title", "color", "collapsed", "windowId"]) {
      assert.deepEqual(continuity.group[key], fixture.group[key], `Native group ${key} changed across manual upgrade`);
    }
    assert.equal(continuity.storage, sentinel, "Extension storage did not survive manual upgrade");
    report.continuity = { group: continuity.group, bothTabGroupIdsRetained: true, extensionStorageRetained: true };
    report.passed = true;
  } catch (error) {
    failed = true; report.error = String(error);
    if (!driver && typeof error?.driverLog === "string") await writeFile(`${output}.log`, error.driverLog);
    throw error;
  } finally {
    const cleanupErrors = [];
    if (driver) {
      try { await driver.close(); } catch (error) { cleanupErrors.push(String(error)); }
      try { await writeFile(`${output}.log`, driver.logs); } catch (error) { cleanupErrors.push(String(error)); }
    }
    if (snapshots) {
      try {
        await rm(snapshots, { recursive: true, force: true });
        process.off("exit", exitCleanup);
      } catch (error) { cleanupErrors.push(String(error)); }
    }
    if (cleanupErrors.length > 0) { report.passed = false; report.cleanupErrors = cleanupErrors; }
    report.finishedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    if (cleanupErrors.length > 0 && !failed) throw new Error("Manual upgrade acceptance cleanup failed; inspect the report");
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseArguments(process.argv.slice(2));
  await runManualUpgrade(options);
  console.log(`Manual signed-XPI upgrade verified: Stackma 1.1.6 → Tab Gantry 1.1.8; ${options.output}`);
}
