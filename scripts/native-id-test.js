import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { FirefoxDriver } from "./webdriver.js";

const output = "artifacts/native-id-test.json";
async function sourceHash() {
  const hash = createHash("sha256");
  for (const file of (await readdir("extension")).sort()) hash.update(file).update(await readFile(`extension/${file}`));
  return hash.digest("hex");
}
const report = {
  startedAt: new Date().toISOString(),
  extensionSha256: await sourceHash(),
  purpose: "Deterministically exercise Firefox's native tab-group ID collision path, not estimate its natural frequency.",
  sourceRevision: "3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1",
  primaryBug: "https://bugzilla.mozilla.org/show_bug.cgi?id=1960104",
  benchmarkAttribution: "This reproduction does not identify the cause of the earlier uninstrumented benchmark failure.",
};
let driver;
try {
  driver = await FirefoxDriver.start({ timeoutMs: 30_000, maxLifetimeMs: 90_000 });
  const addonId = await driver.installAddon("extension");
  report.browser = { version: driver.capabilities.browserVersion, buildId: driver.capabilities["moz:buildID"] };
  const ids = await driver.addon(addonId, async browser => {
    const window = await browser.windows.create({ url: "about:blank" });
    const ids = [window.tabs[0].id];
    for (let index = 1; index < 102; index++) ids.push((await browser.tabs.create({ windowId: window.id, active: false })).id);
    return ids;
  });
  report.nativeCreation = await driver.chrome(ids => {
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const tabs = ids.map(id => ExtensionParent.apiManager.global.tabTracker.getTab(id));
    const tabbrowser = tabs[0].documentGlobal.gBrowser;
    const realm = Cu.waiveXrays(Cu.getGlobalForObject(tabbrowser.addTabGroup));
    const originalNow = realm.Date.now;
    const time = 1_750_000_000_000;
    let first;
    let second;
    const seen = new Map();
    const groups = [];
    // No await, timer or nested event loop inside this override. It applies only
    // to this isolated test browser, and restores even on failure. With a fixed
    // clock, the native formula has 101 possible suffixes. 102 creations must
    // collide, independent of randomness; no RNG override is needed.
    try {
      realm.Date.now = () => time;
      for (const [index, tab] of tabs.entries()) {
        const group = tabbrowser.addTabGroup([tab], { color: "blue", label: `collision-${index}` });
        groups.push(group);
        if (!second && seen.has(group.id)) {
          first = seen.get(group.id);
          second = group;
        }
        if (!seen.has(group.id)) seen.set(group.id, group);
      }
    } finally {
      realm.Date.now = originalNow;
    }
    if (!first || !second) throw new Error("102 native IDs unexpectedly avoided the 101-value pigeonhole");
    return {
      distinctElements: first !== second,
      ids: [first.id, second.id],
      titles: [first.name, second.name],
      tabIds: [first.tabs[0], second.tabs[0]].map(tab => ExtensionParent.apiManager.global.tabTracker.getId(tab)),
      allIds: groups.map(group => group.id),
      groupsWithSameId: tabbrowser.tabGroups.filter(group => group.id === first.id).length,
      tabCounts: [first.tabs.length, second.tabs.length],
      clockRestored: realm.Date.now === originalNow,
      lookupReturnsFirst: tabbrowser.getTabGroupById(second.id) === first,
    };
  }, ids);
  assert.equal(report.nativeCreation.distinctElements, true);
  assert.equal(report.nativeCreation.ids[0], report.nativeCreation.ids[1]);
  assert.ok(report.nativeCreation.allIds.every(id => /^1750000000000-[0-9]{1,3}$/.test(id)));
  assert.ok(report.nativeCreation.groupsWithSameId >= 2);
  assert.deepEqual(report.nativeCreation.tabCounts, [1, 1]);
  assert.equal(report.nativeCreation.clockRestored, true);
  assert.equal(report.nativeCreation.lookupReturnsFirst, true);

  report.extensionAPI = await driver.addon(addonId, async (browser, ids) => {
    const tabs = await Promise.all(ids.map(id => browser.tabs.get(id)));
    const groupId = tabs[1].groupId;
    const groups = (await browser.tabGroups.query({})).filter(group => group.id === groupId);
    const retrieved = await browser.tabGroups.get(groupId);
    const updated = await browser.tabGroups.update(groupId, { title: "update-by-ambiguous-id" });
    return { tabGroupIds: tabs.map(tab => tab.groupId), groups, retrieved, updated };
  }, report.nativeCreation.tabIds);
  assert.ok(report.extensionAPI.groups.length >= 2);
  assert.equal(new Set(report.extensionAPI.tabGroupIds).size, 1);
  assert.equal(report.extensionAPI.retrieved.title, report.nativeCreation.titles[0]);

  report.afterUpdate = await driver.chrome(ids => {
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    return ids.map(id => {
      const group = ExtensionParent.apiManager.global.tabTracker.getTab(id).group;
      return { id: group.id, title: group.name, color: group.color };
    });
  }, report.nativeCreation.tabIds);
  assert.deepEqual(report.afterUpdate.map(group => group.title), ["update-by-ambiguous-id", report.nativeCreation.titles[1]]);

  const popup = await driver.addon(addonId, browser => browser.tabs.create({
    active: true, url: browser.runtime.getURL("popup.html"),
  }));
  report.popupGuard = await driver.tab(popup.id, async groupId => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const open = [...document.querySelectorAll(`button[data-group-id="${groupId}"][data-action="open"]`)];
      if (open.length >= 2) return {
        matchingRows: open.length,
        allOpenDisabled: open.every(button => button.disabled),
        allCopyEnabled: [...document.querySelectorAll(`button[data-group-id="${groupId}"][data-action="copy"]`)]
          .every(button => !button.disabled),
        message: document.querySelector("#message").textContent,
      };
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Popup did not display the colliding native groups");
  }, report.extensionAPI.retrieved.id);
  assert.equal(report.popupGuard.allOpenDisabled, true);
  assert.equal(report.popupGuard.allCopyEnabled, true);

  await driver.chrome(ids => {
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    for (const id of ids) ExtensionParent.apiManager.global.tabTracker.getTab(id).group.name = "";
  }, report.nativeCreation.tabIds);
  report.namerGuard = await driver.addon(addonId, async (browser, sourceId) => {
    const { createNamer } = await import(browser.runtime.getURL("namer.js"));
    const source = await browser.tabs.get(sourceId);
    const reportedErrors = [];
    const namer = createNamer(browser, { onError: error => reportedErrors.push(String(error)) });
    await namer.enqueue(source.groupId, source.windowId, source.incognito);
    await namer.idle();
    return { reportedErrors };
  }, report.nativeCreation.tabIds[1]);
  report.namerGuard.nativeTitles = await driver.chrome(ids => {
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    return ids.map(id => ExtensionParent.apiManager.global.tabTracker.getTab(id).group.name);
  }, report.nativeCreation.tabIds);
  assert.deepEqual(report.namerGuard.nativeTitles, ["", ""]);
  assert.equal(report.namerGuard.reportedErrors.length, 1);
  assert.match(report.namerGuard.reportedErrors[0], /ambiguous|duplicate/i);

  report.membershipGuard = await driver.addon(addonId, async (browser, sourceId) => {
    const { createGroupIdGuard } = await import(browser.runtime.getURL("group-id-guard.js"));
    const { createStacker } = await import(browser.runtime.getURL("stacker.js"));
    const source = await browser.tabs.get(sourceId);
    const child = await browser.tabs.create({ windowId: source.windowId, active: false });
    if (child.groupId !== -1 || child.openerTabId !== undefined) {
      throw new Error("Collision fixture child must begin unrelated and ungrouped");
    }
    const reportedErrors = [];
    const guard = createGroupIdGuard(browser);
    const stacker = createStacker(browser, {
      validateGroupIds: guard.validate,
      onError: error => reportedErrors.push(String(error)),
    });
    await stacker.enqueue({ tabId: child.id, sourceTabId: source.id, windowId: source.windowId });
    await stacker.idle();
    return { reportedErrors, sourceTabId: source.id, childTabId: child.id, windowId: source.windowId };
  }, report.nativeCreation.tabIds[1]);
  report.membershipGuard.nativeState = await driver.chrome((ids, childId) => {
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const tracker = ExtensionParent.apiManager.global.tabTracker;
    const [first, second] = ids.map(id => tracker.getTab(id).group);
    const child = tracker.getTab(childId);
    return {
      distinctElements: first !== second,
      memberTabIds: [first, second].map(group => group.tabs.map(tab => tracker.getId(tab))),
      nativeTitles: [first.name, second.name],
      childGrouped: Boolean(child.group),
      childInSourceWindow: child.documentGlobal === second.documentGlobal,
    };
  }, report.nativeCreation.tabIds, report.membershipGuard.childTabId);
  assert.equal(report.membershipGuard.reportedErrors.length, 1);
  assert.match(report.membershipGuard.reportedErrors[0], /ambiguous|duplicate/i);
  assert.equal(report.membershipGuard.nativeState.distinctElements, true);
  assert.deepEqual(report.membershipGuard.nativeState.memberTabIds, report.nativeCreation.tabIds.map(id => [id]));
  assert.deepEqual(report.membershipGuard.nativeState.nativeTitles, ["", ""]);
  assert.equal(report.membershipGuard.nativeState.childGrouped, false);
  assert.equal(report.membershipGuard.nativeState.childInSourceWindow, true);

  report.extensionSha256After = await sourceHash();
  assert.equal(report.extensionSha256After, report.extensionSha256, "Extension changed during native-ID guard verification");
  report.passed = true;
  console.log("PASS native Firefox ID collision reproduced; production naming, membership and popup guards avoid ambiguous mutations.");
} catch (error) {
  report.passed = false;
  report.error = String(error);
  report.remoteStack = error.remoteStack;
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir("artifacts", { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (driver) {
    await driver.close();
    await writeFile(`${output}.log`, driver.logs);
  }
}
