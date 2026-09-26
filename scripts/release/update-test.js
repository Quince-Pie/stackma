import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FirefoxDriver } from "../webdriver.js";
import { compareReleaseTags, versionFromTag } from "./package.js";

const id = "stackma@extensions.local";

export function parseArguments(args) {
  const values = {};
  for (const arg of args) {
    const match = /^--(from-xpi|from-version|to-version|to-sha256|output)=(.+)$/u.exec(arg);
    assert(match && !Object.hasOwn(values, match[1]), "Use each required --name=value argument exactly once");
    values[match[1]] = match[2];
  }
  for (const key of ["from-xpi", "from-version", "to-version", "to-sha256", "output"]) assert(values[key], `Missing --${key}`);
  versionFromTag(`v${values["from-version"]}`); versionFromTag(`v${values["to-version"]}`);
  assert(compareReleaseTags(`v${values["from-version"]}`, `v${values["to-version"]}`) < 0, "The expected update must be newer");
  assert.match(values["to-sha256"], /^[a-f0-9]{64}$/u, "Expected signed XPI SHA-256 must be 64 lowercase hexadecimal characters");
  const fromXpi = resolve(values["from-xpi"]), output = resolve(values.output);
  assert(fromXpi !== output && fromXpi !== `${output}.log`, "Acceptance output must not overwrite its input XPI");
  return { fromXpi, fromVersion: values["from-version"], toVersion: values["to-version"], toSha256: values["to-sha256"], output };
}

async function outputPreflight(fromXpi, output) {
  const paths = [resolve(fromXpi), resolve(output), resolve(`${output}.log`)];
  assert(new Set(paths).size === paths.length, "Acceptance input, report and log paths must differ");
  const observed = await Promise.all(paths.map(async path => {
    try { return { info: await stat(path, { bigint: true }) }; }
    catch (error) { if (error.code === "ENOENT") return { error }; throw error; }
  }));
  const aliases = (a, b) => a.info && b.info && a.info.dev === b.info.dev && a.info.ino === b.info.ino;
  assert(!aliases(observed[0], observed[1]), "Acceptance report aliases the input XPI");
  assert(!aliases(observed[0], observed[2]), "Acceptance log aliases the input XPI");
  assert(!aliases(observed[1], observed[2]), "Acceptance report and log alias the same file");
  return observed[0];
}

// This function is serialized into the real Firefox chrome process. It must
// capture no Node variables. Unit mocks exercise its controls, not delivery.
export async function browserUpdate({ id, fromVersion, toVersion, toSha256, timeoutMs = 120_000 }) {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const addon = await AddonManager.getAddonByID(id);
  const checkAddon = (value, version) => {
    ensure(value?.id === id && value.version === version, "Installed add-on identity/version differs");
    ensure(value.signedState === AddonManager.SIGNEDSTATE_SIGNED && !value.temporarilyInstalled && value.isActive,
      "A permanent active Mozilla-signed installation is required");
    ensure(!value.updateURL, "Custom add-on update URLs are not accepted");
  };
  checkAddon(addon, fromVersion);
  ensure(Services.prefs.getBoolPref("xpinstall.signatures.required"), "Signature enforcement must remain enabled");
  const endpoint = Services.prefs.getStringPref("extensions.update.url");
  ensure(endpoint === Services.prefs.getDefaultBranch("").getStringPref("extensions.update.url"), "Firefox update endpoint was overridden");
  ensure(new URL(endpoint).origin === "https://versioncheck.addons.mozilla.org", "Unexpected default Firefox update service");
  ensure(!Services.policies?.getExtensionSettings(id)?.update_url, "Enterprise policy overrides the add-on update URL");
  let install, listener, timer, completed = false, stopped = false;
  const events = [];
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Firefox AMO update acceptance timed out")), timeoutMs); });
  const work = async () => {
    install = await new Promise((resolveUpdate, reject) => {
      let offered;
      addon.findUpdates({
        onUpdateAvailable(_addon, candidate) { offered = candidate; events.push("update-available"); },
        onUpdateFinished(_addon, error) {
          if (error !== AddonManager.UPDATE_STATUS_NO_ERROR) reject(new Error(`Firefox update check failed (${error})`));
          else if (!offered) reject(new Error("AMO offered no compatible newer version"));
          else resolveUpdate(offered);
        },
      }, AddonManager.UPDATE_WHEN_USER_REQUESTED);
    });
    ensure(!stopped, "Update acceptance already stopped");
    ensure(install.version === toVersion && install.existingAddon?.id === id, "AMO offered a different update than expected");
    ensure(install.state === AddonManager.STATE_AVAILABLE, "Update already started outside this acceptance test");
    const downloadUrl = install.sourceURI.spec;
    ensure(["https://addons.mozilla.org", "https://addons.mozilla.net"].includes(new URL(downloadUrl).origin), "Unexpected AMO update download origin");
    const waitFor = phase => new Promise((done, reject) => {
      const failed = event => { events.push(event); reject(new Error(`Firefox ${event} (${install.error})`)); };
      listener = {
        onDownloadEnded() { events.push("download-ended"); if (phase === "download") done(); return false; },
        onInstallEnded() { events.push("install-ended"); if (phase === "install") done(); },
        onDownloadFailed() { failed("download-failed"); },
        onDownloadCancelled() { failed("download-cancelled"); },
        onInstallFailed() { failed("install-failed"); },
        onInstallCancelled() { failed("install-cancelled"); },
        onInstallPostponed() { failed("install-postponed"); },
      };
      install.addListener(listener);
      try { Promise.resolve(install.install()).catch(reject); } catch (error) { reject(error); }
    });
    await waitFor("download");
    install.removeListener(listener); listener = null;
    ensure(install.state === AddonManager.STATE_DOWNLOADED && install.error === 0, "Firefox did not accept the downloaded XPI");
    ensure(install.addon?.id === id && install.addon.version === toVersion && install.addon.signedState === AddonManager.SIGNEDSTATE_SIGNED,
      "Downloaded XPI identity/version/signature differs");
    const path = install.file?.path;
    ensure(typeof path === "string" && path.length > 0, "Firefox did not retain its downloaded XPI");
    const info = await IOUtils.stat(path);
    ensure(info.type === "regular" && info.size > 0 && info.size <= 200_000_000, "Downloaded XPI exceeds the accepted file bounds");
    const bytes = await IOUtils.read(path);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    ensure(hash === toSha256, "Firefox downloaded different XPI bytes than the expected signed release");
    ensure(!stopped, "Update acceptance already stopped");
    events.push("download-sha256-verified");
    await waitFor("install");
    install.removeListener(listener); listener = null;
    checkAddon(await AddonManager.getAddonByID(id), toVersion);
    completed = true;
    return { id, fromVersion, toVersion, sha256: hash, bytes: bytes.length, downloadUrl, updateEndpoint: endpoint, events };
  };
  try { return await Promise.race([work(), deadline]); }
  finally {
    stopped = true;
    clearTimeout(timer);
    if (listener && install) install.removeListener(listener);
    if (!completed) {
      try { addon.cancelUpdate(); } catch {}
      try { install?.cancel(); } catch {}
    }
  }
}

export async function runAcceptance(options) {
  const { fromXpi, fromVersion, toVersion, toSha256, output } = options;
  // Outputs are exclusive scratch files for this invocation. Follow ordinary
  // symlinks, but reject observed hardlink/symlink inode aliases before any
  // report or log write, including failure reporting. This is a preflight,
  // not protection against another process changing links concurrently.
  const input = await outputPreflight(fromXpi, output);
  const report = { passed: false, scope: "actual Firefox 156 default-AMO installed-user update in a disposable profile",
    startedAt: new Date().toISOString(), fromVersion, toVersion, expectedSignedSha256: toSha256 };
  await mkdir(dirname(output), { recursive: true });
  // An interrupt may exit through FirefoxDriver's signal handler before our
  // finally block. Leave a non-success record even on that path.
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  let driver;
  try {
    if (input.error) throw input.error;
    const info = input.info;
    assert(info.isFile() && info.size > 0 && info.size <= 200_000_000, "Older signed XPI must be a regular file of at most 200 MB");
    report.fromSha256 = createHash("sha256").update(await readFile(fromXpi)).digest("hex");
    driver = await FirefoxDriver.start({ timeoutMs: 125_000, startupTimeoutMs: 30_000, maxLifetimeMs: 150_000, expectedMajor: 156,
      prefs: {
        "network.proxy.type": 0, "xpinstall.signatures.required": true,
        "extensions.update.enabled": true, "extensions.update.autoUpdateDefault": false,
        "app.update.disabledForTesting": true, "browser.newtabpage.enabled": false,
        "browser.newtabpage.activity-stream.feeds.telemetry": false, "browser.newtabpage.activity-stream.telemetry": false,
        "datareporting.healthreport.uploadEnabled": false, "datareporting.policy.dataSubmissionEnabled": false,
        "toolkit.telemetry.enabled": false, "toolkit.telemetry.unified": false, "toolkit.telemetry.archive.enabled": false,
        "app.shield.optoutstudies.enabled": false, "browser.discovery.enabled": false,
        "network.prefetch-next": false, "network.dns.disablePrefetch": true,
      } });
    report.browser = { version: driver.capabilities.browserVersion, buildId: driver.capabilities["moz:buildID"], geckodriver: driver.capabilities["moz:geckodriverVersion"] };
    // Marionette's recommended preferences replace update services with dummy
    // URLs. Restore Firefox's own shipped defaults in this disposable profile;
    // never substitute an update manifest or an expected package URL.
    report.network = await driver.chrome(() => {
      for (const name of ["extensions.update.url", "extensions.update.background.url"]) Services.prefs.clearUserPref(name);
      return { proxyType: Services.prefs.getIntPref("network.proxy.type"),
        updateEndpoint: Services.prefs.getStringPref("extensions.update.url"),
        backgroundEndpoint: Services.prefs.getStringPref("extensions.update.background.url") };
    });
    assert.equal(await driver.installAddon(fromXpi, { temporary: false }), id);
    const fixture = await driver.addon(id, async browser => {
      const manifest = browser.runtime.getManifest();
      if (manifest.browser_specific_settings?.gecko?.update_url) throw new Error("Input XPI has a custom update URL");
      const parent = await browser.tabs.create({ active: false });
      const child = await browser.tabs.create({ openerTabId: parent.id, windowId: parent.windowId, active: false });
      let groupId;
      for (let i = 0; i < 200; i++) {
        const [a, b] = await Promise.all([browser.tabs.get(parent.id), browser.tabs.get(child.id)]);
        if (a.groupId >= 0 && a.groupId === b.groupId && (await browser.tabGroups.get(a.groupId)).title) {
          groupId = a.groupId; break;
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      }
      if (groupId === undefined) throw new Error("Older installed extension did not group and name related tabs");
      await browser.tabGroups.update(groupId, { title: "Update continuity — 日本語", color: "purple", collapsed: true });
      await browser.storage.local.set({ releaseUpdateAcceptance: "retained-value" });
      return { parent: parent.id, child: child.id, group: await browser.tabGroups.get(groupId) };
    });
    report.delivery = await driver.chrome(browserUpdate, { id, fromVersion, toVersion, toSha256 });
    const after = await driver.addon(id, async (browser, fixture) => {
      const [parent, child] = await Promise.all([browser.tabs.get(fixture.parent), browser.tabs.get(fixture.child)]);
      return { parentGroup: parent.groupId, childGroup: child.groupId, group: await browser.tabGroups.get(parent.groupId),
        storage: (await browser.storage.local.get("releaseUpdateAcceptance")).releaseUpdateAcceptance };
    }, fixture);
    assert.equal(after.parentGroup, fixture.group.id); assert.equal(after.childGroup, fixture.group.id);
    for (const key of ["id", "title", "color", "collapsed", "windowId"]) assert.deepEqual(after.group[key], fixture.group[key], `Native group ${key} changed across update`);
    assert.equal(after.storage, "retained-value");
    report.continuity = { group: after.group, extensionStorage: true };
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    if (!driver && typeof error?.driverLog === "string") await writeFile(`${output}.log`, error.driverLog);
    throw error;
  } finally {
    try { if (driver) await driver.close(); }
    catch (error) { report.passed = false; report.cleanupError = String(error); throw error; }
    finally {
      report.finishedAt = new Date().toISOString();
      if (driver) await writeFile(`${output}.log`, driver.logs);
      await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseArguments(process.argv.slice(2));
  await runAcceptance(options);
  console.log(`Verified actual Firefox AMO update ${options.fromVersion} → ${options.toVersion}; report: ${options.output}`);
}
