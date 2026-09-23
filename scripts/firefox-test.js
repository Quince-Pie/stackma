import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { FirefoxDriver } from "./webdriver.js";

const artifactDir = "artifacts";
await mkdir(artifactDir, { recursive: true });
const candidate = process.argv.find(arg => arg.startsWith("--candidate="))?.split("=")[1];
let extensionPath = "extension";
let temporaryExtension;
if (candidate) {
  if (candidate !== "dependency") throw new Error("Unsupported candidate");
  temporaryExtension = await mkdtemp(join(tmpdir(), "stackma-candidate-"));
  extensionPath = join(temporaryExtension, "extension");
  await cp("extension", extensionPath, { recursive: true });
  await cp("experiments/dependency-stacker.js", join(extensionPath, "stacker.js"));
}
const artifactName = candidate ? `firefox-tests-${candidate}` : "firefox-tests";
const files = (await readdir(extensionPath)).sort();
const hash = createHash("sha256");
for (const file of files) hash.update(file).update(await readFile(`${extensionPath}/${file}`));
const report = { sourceSha256: hash.digest("hex"), startedAt: new Date().toISOString(), results: [] };
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Stackma browser fixture</title>
    <a id="link" target="_blank" href="/target">Related link</a>
    <a id="noreferrer" target="_blank" rel="noreferrer" href="/target">Noreferrer link</a>
    ${request.url === "/frame" ? "" : '<iframe src="/frame"></iframe>'}`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let driver;
try {
  driver = await FirefoxDriver.start({
    timeoutMs: 40_000,
    maxLifetimeMs: 300_000,
    prefs: { "dom.disable_open_during_load": false },
  });
  const id = await driver.installAddon(extensionPath);
  report.extraExtensions = await driver.chrome(async addonId => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return (await AddonManager.getAddonsByTypes(["extension"]))
      .filter(addon => addon.isActive && !addon.isSystem && !addon.isBuiltin && addon.id !== addonId)
      .map(addon => ({ id: addon.id, version: addon.version }));
  }, id);
  assert.deepEqual(report.extraExtensions, [], "Browser tests require an isolated extension environment");
  report.browser = {
    version: driver.capabilities.browserVersion,
    buildId: driver.capabilities["moz:buildID"],
    geckodriver: driver.capabilities["moz:geckodriverVersion"],
    platform: driver.capabilities.platformName,
  };

  async function test(name, run) {
    const started = performance.now();
    try {
      const details = await run();
      report.results.push({ name, passed: true, durationMs: performance.now() - started, details });
      console.log(`PASS ${name}`);
    } catch (error) {
      report.results.push({ name, passed: false, error: String(error), remoteStack: error.remoteStack });
      throw error;
    }
  }

  await test("split-view-group-creation", async () => {
    const ids = await driver.addon(id, async browser => {
      const tabs = await Promise.all(Array.from({ length: 3 }, () => browser.tabs.create({ active: false })));
      return tabs.map(tab => tab.id);
    });
    const splitId = await driver.chrome(ids => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const [source, companion] = [ids[0], ids[2]].map(id => ExtensionParent.apiManager.global.tabTracker.getTab(id));
      return source.documentGlobal.gBrowser.addTabSplitView([source, companion], { insertBefore: source }).splitViewId;
    }, ids);
    const tabs = await driver.addon(id, async (browser, ids) => {
      const { createStacker } = await import(browser.runtime.getURL("stacker.js"));
      const source = await browser.tabs.get(ids[0]);
      const errors = [];
      const stacker = createStacker(browser, { onError: error => errors.push(String(error)) });
      await stacker.enqueue({ tabId: ids[1], sourceTabId: ids[0], windowId: source.windowId });
      if (errors.length) throw new Error(errors.join("; "));
      return Promise.all(ids.map(id => browser.tabs.get(id)));
    }, ids);
    assert.ok(tabs[0].groupId >= 0);
    assert.ok(tabs.every(tab => tab.groupId === tabs[0].groupId));
    assert.equal(tabs[0].splitViewId, splitId);
    assert.equal(tabs[2].splitViewId, splitId);
    await driver.addon(id, (browser, ids) => browser.tabs.remove(ids), ids);
  });

  await test("private-split-view-fallback-and-group-metadata", async () => {
    const data = await driver.addon(id, async browser => {
      const normal = await browser.windows.getCurrent();
      const window = await browser.windows.create({ incognito: true, focused: true });
      const tabs = await Promise.all(Array.from({ length: 3 }, () => browser.tabs.create({ windowId: window.id, active: false })));
      await browser.tabs.group({ tabIds: tabs[0].id, createProperties: { windowId: window.id } });
      await browser.windows.update(normal.id, { focused: true });
      return { ids: tabs.map(tab => tab.id), windowId: window.id };
    });
    const splitId = await driver.chrome(ids => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const [source, child, companion] = ids.map(id => ExtensionParent.apiManager.global.tabTracker.getTab(id));
      source.group.name = "Research";
      source.group.color = "purple";
      source.group.collapsed = true;
      return source.documentGlobal.gBrowser.addTabSplitView([child, companion], { insertBefore: child }).splitViewId;
    }, data.ids);
    const tabs = await driver.addon(id, async (browser, data) => {
      const { createStacker } = await import(browser.runtime.getURL("stacker.js"));
      const errors = [];
      const stacker = createStacker(browser, { onError: error => errors.push(String(error)) });
      await stacker.enqueue({ tabId: data.ids[1], sourceTabId: data.ids[0], windowId: data.windowId });
      if (errors.length) throw new Error(errors.join("; "));
      return Promise.all(data.ids.map(id => browser.tabs.get(id)));
    }, data);
    assert.ok(tabs.every(tab => tab.groupId === tabs[0].groupId && tab.incognito && tab.windowId === data.windowId));
    assert.equal(tabs[1].splitViewId, splitId);
    assert.equal(tabs[2].splitViewId, splitId);
    const metadata = await driver.chrome(sourceId => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const group = ExtensionParent.apiManager.global.tabTracker.getTab(sourceId).group;
      return { name: group.name, color: group.color, collapsed: group.collapsed };
    }, data.ids[0]);
    assert.deepEqual(metadata, { name: "Research", color: "purple", collapsed: true });
    await driver.addon(id, (browser, windowId) => browser.windows.remove(windowId), data.windowId);
  });

  await test("container-identities", async () => {
    const ids = await driver.chrome(() => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const window = Services.wm.getMostRecentWindow("navigator:browser");
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const source = window.gBrowser.addTab("about:blank", { userContextId: 1, triggeringPrincipal: principal });
      const child = window.gBrowser.addTab("about:blank", { userContextId: 2, openerBrowser: source.linkedBrowser, triggeringPrincipal: principal });
      return [source, child].map(tab => ExtensionParent.apiManager.global.tabTracker.getId(tab));
    });
    await driver.addon(id, async (browser, ids) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const [source, child] = await Promise.all(ids.map(id => browser.tabs.get(id)));
        if (source.groupId >= 0 && child.groupId === source.groupId) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Container tabs did not group");
    }, ids);
    const containers = await driver.chrome(ids => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      return ids.map(id => ExtensionParent.apiManager.global.tabTracker.getTab(id).getAttribute("usercontextid"));
    }, ids);
    assert.deepEqual(containers, ["1", "2"]);
    await driver.addon(id, (browser, ids) => browser.tabs.remove(ids), ids);
  });

  for (const name of ["create", "inherit", "burst", "chain", "pins", "background-window", "private-fallback", "late-parent"]) {
    await test(name, () => driver.addon(id, async (browser, scenario) => {
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      async function grouped(ids) {
        for (let attempt = 0; attempt < 200; attempt++) {
          const tabs = await Promise.all(ids.map(id => browser.tabs.get(id)));
          if (tabs[0].groupId >= 0 && tabs.every(tab => tab.groupId === tabs[0].groupId)) return tabs;
          await delay(10);
        }
        throw new Error(`Grouping timed out: ${JSON.stringify(await Promise.all(ids.map(id => browser.tabs.get(id))))}`);
      }
      const created = [];
      const windows = [];
      const make = async properties => {
        const tab = await browser.tabs.create({ active: false, ...properties });
        created.push(tab.id);
        return tab;
      };
      try {
        const parent = await make({});
        const initialActive = (await browser.tabs.query({ active: true, windowId: parent.windowId }))[0].id;
        if (scenario === "create") {
          const child = await make({ openerTabId: parent.id, windowId: parent.windowId });
          const tabs = await grouped([parent.id, child.id]);
          check((await browser.tabs.query({ active: true, windowId: parent.windowId }))[0].id === initialActive, "Selection changed");
          check(tabs.every(tab => tab.windowId === parent.windowId), "Window changed");
          await browser.tabs.ungroup(child.id);
          await delay(150);
          check((await browser.tabs.get(child.id)).groupId === -1, "Manual ungroup was undone");
        } else if (scenario === "inherit") {
          const original = await browser.tabs.group({ tabIds: parent.id, createProperties: { windowId: parent.windowId } });
          const child = await make({ openerTabId: parent.id, windowId: parent.windowId });
          const tabs = await grouped([parent.id, child.id]);
          check(tabs[0].groupId === original, "Existing group replaced");
        } else if (scenario === "burst") {
          const children = await Promise.all(Array.from({ length: 96 }, () => make({ openerTabId: parent.id, windowId: parent.windowId })));
          await grouped([parent.id, ...children.map(tab => tab.id)]);
          await delay(100);
          await grouped([parent.id, ...children.map(tab => tab.id)]);
        } else if (scenario === "chain") {
          let previous = parent;
          for (let index = 0; index < 24; index++) previous = await make({ openerTabId: previous.id, windowId: parent.windowId });
          await grouped(created);
        } else if (scenario === "pins") {
          await browser.tabs.update(parent.id, { pinned: true });
          const child = await make({ openerTabId: parent.id, windowId: parent.windowId });
          const other = await make({});
          const pinnedChild = await make({ openerTabId: other.id, pinned: true, windowId: other.windowId });
          await delay(250);
          const tabs = await Promise.all([parent.id, child.id, other.id, pinnedChild.id].map(id => browser.tabs.get(id)));
          check(tabs.every(tab => tab.groupId === -1), "Pinned relationship grouped");
          check(tabs[0].pinned && tabs[3].pinned, "A pin was removed");
        } else if (scenario === "background-window") {
          const foreground = await browser.windows.create({ focused: true });
          windows.push(foreground.id);
          const child = await make({ openerTabId: parent.id, windowId: parent.windowId });
          const tabs = await grouped([parent.id, child.id]);
          check(tabs.every(tab => tab.windowId === parent.windowId), "A background group moved to the foreground window");
        } else if (scenario === "private-fallback") {
          const privateWindow = await browser.windows.create({ incognito: true, focused: true });
          windows.push(privateWindow.id);
          const source = await make({ windowId: privateWindow.id });
          const target = await make({ windowId: privateWindow.id });
          const original = await browser.tabs.group({ tabIds: source.id, createProperties: { windowId: privateWindow.id } });
          await browser.windows.update(parent.windowId, { focused: true });
          const { createStacker } = await import(browser.runtime.getURL("stacker.js"));
          const failures = [];
          const stacker = createStacker(browser, { onError: error => failures.push(String(error)) });
          await stacker.enqueue({ tabId: target.id, sourceTabId: source.id, windowId: privateWindow.id });
          check(!failures.length, failures.join("; "));
          const tabs = await grouped([source.id, target.id]);
          check(tabs[0].groupId === original && tabs.every(tab => tab.incognito && tab.windowId === privateWindow.id), "Private grouping changed privacy or window");
          check(!failures.length, failures.join("; "));
        } else if (scenario === "late-parent") {
          const child = await make({ windowId: parent.windowId });
          const descendant = await make({ windowId: parent.windowId });
          const { createStacker } = await import(browser.runtime.getURL("stacker.js"));
          const stacker = createStacker(browser);
          await stacker.enqueue({ tabId: descendant.id, sourceTabId: child.id, windowId: parent.windowId });
          await stacker.enqueue({ tabId: child.id, sourceTabId: parent.id, windowId: parent.windowId });
          await grouped([parent.id, child.id, descendant.id]);
        }
        check(await browser.action.getBadgeText({}) !== "!", "Production background reported an error");
        return { tabs: created.length };
      } finally {
        for (const tabId of created) await browser.tabs.remove(tabId).catch(() => {});
        for (const windowId of windows) await browser.windows.remove(windowId).catch(() => {});
      }
    }, name));
  }

  await test("native-session-window-restore", async () => {
    const ids = await driver.addon(id, async browser => {
      const window = await browser.windows.create({ url: ["about:blank#source", "about:blank#child", "about:blank#unrelated"] });
      const ids = window.tabs.map(tab => tab.id);
      await browser.tabs.group({ tabIds: ids.slice(0, 2), createProperties: { windowId: window.id } });
      return ids;
    });
    const restored = await driver.chrome(async sourceId => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
      const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
      const source = ExtensionParent.apiManager.global.tabTracker.getTab(sourceId);
      const window = source.documentGlobal;
      source.group.name = "Persisted";
      source.group.color = "blue";
      await TabStateFlusher.flushWindow(window);
      const closed = new Promise(resolve => window.addEventListener("unload", resolve, { once: true }));
      window.close();
      await closed;
      const reopened = SessionStore.undoCloseWindow(0);
      await new Promise(resolve => reopened.addEventListener("SSWindowStateReady", resolve, { once: true }));
      const groups = reopened.gBrowser.tabGroups;
      return {
        groups: groups.map(group => ({ name: group.name, color: group.color, members: group.tabs.length })),
        tabs: reopened.gBrowser.tabs.length,
        sourceId: ExtensionParent.apiManager.global.tabTracker.getId(groups[0].tabs[0]),
        windowId: ExtensionParent.apiManager.global.windowTracker.getId(reopened),
      };
    }, ids[0]);
    assert.equal(restored.tabs, 3);
    assert.deepEqual(restored.groups, [{ name: "Persisted", color: "blue", members: 2 }]);
    await driver.addon(id, async (browser, restored) => {
      const source = await browser.tabs.get(restored.sourceId);
      const child = await browser.tabs.create({ openerTabId: source.id, windowId: source.windowId, active: false });
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await browser.tabs.get(child.id)).groupId === source.groupId) {
          await browser.windows.remove(restored.windowId);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("A restored opener did not retain grouping behavior");
    }, restored);
  });

  async function page() {
    const url = `${base}/source?${report.results.length}`;
    const tab = await driver.addon(id, (browser, url) => browser.tabs.create({ url, active: true }), url);
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const ready = await driver.tab(tab.id, url => location.href === url && document.readyState === "complete", url);
        if (ready) return tab;
      } catch (error) {
        if (!/Actor .*destroyed/.test(String(error))) throw error;
      }
      await delay(10);
    }
    throw new Error("Fixture page did not load");
  }

  async function expectLinkGroup(sourceId, { separateWindow = false } = {}) {
    return driver.addon(id, async (browser, sourceId, separateWindow) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const source = await browser.tabs.get(sourceId);
        const tabs = await browser.tabs.query({});
        const targets = tabs.filter(tab => tab.id !== sourceId && !tab.pinned && tab.id > sourceId);
        const child = targets.find(tab => separateWindow ? tab.windowId !== source.windowId : tab.groupId === source.groupId && source.groupId >= 0);
        if (child) {
          if (separateWindow && (child.groupId !== -1 || source.groupId !== -1)) throw new Error("Cross-window link was grouped");
          return { sourceId, childId: child.id, sourceWindow: source.windowId, childWindow: child.windowId, openerTabId: child.openerTabId ?? null };
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Link relationship was not handled");
    }, sourceId, separateWindow);
  }

  await test("navigation-source-without-tab-opener", async () => {
    const source = await page();
    await driver.addon(id, browser => {
      window.stackmaCreationProbe = [];
      window.stackmaProbeListener = tab => window.stackmaCreationProbe.push({ id: tab.id, opener: tab.openerTabId ?? null });
      browser.tabs.onCreated.addListener(window.stackmaProbeListener);
    });
    await driver.chrome((sourceId, url) => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const { URILoadingHelper } = ChromeUtils.importESModule("resource:///modules/URILoadingHelper.sys.mjs");
      const source = ExtensionParent.apiManager.global.tabTracker.getTab(sourceId);
      URILoadingHelper.openLinkIn(source.documentGlobal, url, "tab", {
        relatedToCurrent: false,
        frameID: source.linkedBrowser.browsingContext.id,
        inBackground: true,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    }, source.id, `${base}/target`);
    const result = await expectLinkGroup(source.id);
    const created = await driver.addon(id, (browser, childId) => {
      browser.tabs.onCreated.removeListener(window.stackmaProbeListener);
      const result = window.stackmaCreationProbe.find(tab => tab.id === childId);
      delete window.stackmaProbeListener;
      delete window.stackmaCreationProbe;
      return result;
    }, result.childId);
    assert.equal(created.opener, null, "This case must exercise navigation's independent source signal");
    await driver.addon(id, (browser, ids) => browser.tabs.remove(ids), [source.id, result.childId]);
    return { ...result, onCreatedOpener: created.opener };
  });

  for (const mode of ["link", "noreferrer", "iframe", "window.open", "separate-window", "wake"]) {
    await test(mode, async () => {
      const source = await page();
      if (mode === "wake") assert.equal(await driver.suspendAddon(id), "stopped");
      await driver.tab(source.id, (mode, target) => {
        if (mode === "iframe") document.querySelector("iframe").contentDocument.querySelector("#link").click();
        else if (mode === "window.open") window.open(target, "_blank", "noopener");
        else if (mode === "separate-window") window.open(target, "_blank", "width=400,height=300");
        else document.querySelector(mode === "noreferrer" ? "#noreferrer" : "#link").click();
      }, mode, `${base}/target`);
      if (mode === "wake") {
        const awakened = await driver.chrome(async addonId => {
          const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
          const extension = ExtensionParent.GlobalManager.getExtension(addonId);
          for (let attempt = 0; attempt < 100; attempt++) {
            if (extension.backgroundState === "running") return true;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          return false;
        }, id);
        assert.equal(awakened, true, "Creation event must wake background without the test waking it");
      }
      const result = await expectLinkGroup(source.id, { separateWindow: mode === "separate-window" });
      await driver.addon(id, (browser, ids) => browser.tabs.remove(ids), [source.id, result.childId]);
      return result;
    });
  }

  await test("named-target-reuse", async () => {
    const source = await page();
    await driver.tab(source.id, target => { window.open(target, "stackma-named"); }, `${base}/target`);
    const initial = await expectLinkGroup(source.id);
    await driver.addon(id, (browser, tabId) => browser.tabs.ungroup(tabId), initial.childId);
    await driver.tab(source.id, target => { window.open(target, "stackma-named"); }, `${base}/target?reused`);
    await driver.addon(id, async (browser, sourceId, childId) => {
      await new Promise(resolve => setTimeout(resolve, 250));
      if ((await browser.tabs.get(childId)).groupId !== -1) throw new Error("Reused named target was grouped again");
      await browser.tabs.remove([sourceId, childId]);
    }, source.id, initial.childId);
  });

  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(`${artifactDir}/${artifactName}.json`, JSON.stringify(report, null, 2) + "\n");
  if (driver) {
    await driver.close();
    await writeFile(`${artifactDir}/${artifactName}.log`, driver.logs);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (temporaryExtension) await rm(temporaryExtension, { recursive: true, force: true });
}
