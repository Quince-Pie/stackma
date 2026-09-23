import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FirefoxDriver } from "./webdriver.js";

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = resolve(argument("source") ?? "extension");
const output = resolve(argument("output") ?? "artifacts/naming-tests.json");
const packBytes = await readFile("naming-data/en-v1.json");
const pack = JSON.parse(packBytes);
const approved = new Set(pack.pairs.map(pair => `${pair.adjective}-${pair.noun}`));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function sourceHash() {
  const hash = createHash("sha256");
  for (const file of (await readdir(source)).sort()) hash.update(file).update(await readFile(`${source}/${file}`));
  return hash.digest("hex");
}
const report = {
  source, sourceSha256: await sourceHash(),
  scriptSha256: digest(await readFile(new URL(import.meta.url))),
  vocabularySha256: digest(packBytes),
  startedAt: new Date().toISOString(), results: [],
};
let driver;
let addonId;
let bootstrapHandle;

async function fixture(count = 1, incognito = false) {
  return driver.addon(addonId, async (browser, count, incognito) => {
    const normal = (await browser.windows.getAll({ windowTypes: ["normal"] })).find(win => !win.incognito);
    const win = await browser.windows.create({ incognito, focused: true, url: "about:blank" });
    const ids = [win.tabs[0].id];
    for (let index = 1; index < count; index++) {
      ids.push((await browser.tabs.create({ windowId: win.id, active: false })).id);
    }
    if (incognito) await browser.windows.update(normal.id, { focused: true });
    return { ids, windowId: win.id, normalWindowId: normal.id, incognito };
  }, count, incognito);
}

async function related(data, sourceId = data.ids[0]) {
  return driver.addon(addonId, (browser, windowId, sourceId) => browser.tabs.create({
    openerTabId: sourceId, windowId, active: false,
  }), data.windowId, sourceId);
}

async function remove(data) {
  // A real popup-page click can make its tab the WebDriver current context.
  // Return to the persistent harness tab before removing the fixture window.
  await driver.command("POST", "/moz/context", { context: "content" });
  await driver.command("POST", "/window", { handle: bootstrapHandle });
  await driver.addon(addonId, (browser, windowId) => browser.windows.remove(windowId), data.windowId);
}

async function groupOf(ids, { named = true } = {}) {
  return driver.addon(addonId, async (browser, ids, named) => {
    let state;
    for (let attempt = 0; attempt < 400; attempt++) {
      const tabs = await Promise.all(ids.map(id => browser.tabs.get(id)));
      if (tabs[0].groupId >= 0 && tabs.every(tab => tab.groupId === tabs[0].groupId)) {
        const group = await browser.tabGroups.get(tabs[0].groupId);
        state = { tabs, group };
        if (!named || group.title) return state;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Group or generated name did not settle: ${JSON.stringify(state)}`);
  }, ids, named);
}

async function nativeMetadata(tabId, properties) {
  return driver.chrome((id, properties) => {
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const group = ExtensionParent.apiManager.global.tabTracker.getTab(id).group;
    if (!group) return null;
    if (properties) Object.assign(group, properties);
    return { id: group.id, name: group.name, color: group.color, collapsed: group.collapsed,
      saveOnWindowClose: group.saveOnWindowClose };
  }, tabId, properties);
}

async function history(expected = []) {
  return driver.addon(addonId, async (browser, expected) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const stored = await browser.storage.session.get(["naming.normal", "naming.private"]);
      if (expected.every(({ key, name, windowId }) => stored[key]?.some(item =>
        item.name === name && item.windowId === windowId))) return stored;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Naming history was not persisted");
  }, expected);
}

async function settledMetadata(tabId) {
  await driver.addon(addonId, async () => new Promise(resolve => setTimeout(resolve, 150)));
  return nativeMetadata(tabId);
}

async function openPopup(data) {
  const tab = await driver.addon(addonId, (browser, windowId) => browser.tabs.create({
    windowId, active: true, url: browser.runtime.getURL("popup.html"),
  }), data.windowId);
  await driver.tab(tab.id, async () => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (document.querySelector("#groups .group")) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Popup group list did not load");
  });
  return tab;
}

async function trustedClick(tabId, selector) {
  const handle = await driver.chrome(id => {
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
    return NavigableManager.getIdForBrowser(ExtensionParent.apiManager.global.tabTracker.getTab(id).linkedBrowser);
  }, tabId);
  await driver.command("POST", "/moz/context", { context: "content" });
  await driver.command("POST", "/window", { handle });
  const element = await driver.command("POST", "/element", { using: "css selector", value: selector });
  await driver.command("POST", `/element/${element["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
}

function assertGenerated(name) {
  assert.ok(approved.has(name), `Expected an independently approved adjective–noun pair, got ${name}`);
}

async function test(name, run) {
  const started = performance.now();
  try {
    const details = await run();
    report.results.push({ name, passed: true, durationMs: performance.now() - started, details });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.results.push({ name, passed: false, durationMs: performance.now() - started,
      error: String(error), remoteStack: error.remoteStack });
    console.error(`FAIL ${name}: ${error}`);
  }
}

try {
  driver = await FirefoxDriver.start({ timeoutMs: 40_000, maxLifetimeMs: 300_000 });
  bootstrapHandle = await driver.command("GET", "/window");
  addonId = await driver.installAddon(source);
  report.browser = {
    version: driver.capabilities.browserVersion, buildId: driver.capabilities["moz:buildID"],
    geckodriver: driver.capabilities["moz:geckodriverVersion"], platform: driver.capabilities.platformName,
  };
  report.extraExtensions = await driver.chrome(async id => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return (await AddonManager.getAddonsByTypes(["extension"]))
      .filter(addon => addon.isActive && !addon.isSystem && !addon.isBuiltin && addon.id !== id)
      .map(addon => addon.id);
  }, addonId);
  assert.deepEqual(report.extraExtensions, []);

  await test("only-required-permissions-and-no-host-access", async () => {
    const actual = await driver.addon(addonId, async browser => ({
      permissions: await browser.permissions.getAll(), manifest: browser.runtime.getManifest(),
    }));
    assert.deepEqual(actual.permissions.permissions.toSorted(), ["storage", "tabGroups", "webNavigation"]);
    assert.deepEqual(actual.permissions.origins, []);
    assert.deepEqual(actual.manifest.permissions.toSorted(), ["storage", "tabGroups", "webNavigation"]);
    assert.deepEqual(actual.manifest.host_permissions ?? [], []);
    assert.deepEqual(actual.manifest.content_scripts ?? [], []);
    return { permissions: actual.permissions, version: actual.manifest.version };
  });

  await test("new-related-group-gets-an-approved-stable-name", async () => {
    const data = await fixture();
    try {
      const child = await related(data);
      const initial = await groupOf([data.ids[0], child.id]);
      assertGenerated(initial.group.title);
      const before = await nativeMetadata(child.id);
      assert.equal(before.collapsed, false);
      const sibling = await related(data);
      const joined = await groupOf([data.ids[0], child.id, sibling.id]);
      assert.equal(joined.group.id, initial.group.id);
      assert.deepEqual(await settledMetadata(sibling.id), before);
      return { title: initial.group.title, color: initial.group.color };
    } finally { await remove(data); }
  });

  for (const title of ["Manual research — 日本語", ""]) {
    await test(`preexisting-${title ? "named" : "blank"}-group-remains-authoritative`, async () => {
      const data = await fixture();
      try {
        const groupId = await driver.addon(addonId, async (browser, data, title) => {
          const id = await browser.tabs.group({ tabIds: data.ids, createProperties: { windowId: data.windowId } });
          await browser.tabGroups.update(id, { title, color: "purple" });
          return id;
        }, data, title);
        const before = await settledMetadata(data.ids[0]);
        assert.equal(before.name, title);
        const child = await related(data);
        const result = await groupOf([data.ids[0], child.id], { named: false });
        assert.equal(result.group.id, groupId);
        assert.deepEqual(await settledMetadata(child.id), before);
      } finally { await remove(data); }
    });
  }

  for (const title of ["My manually edited group", ""]) {
    await test(`manual-${title ? "rename" : "clear"}-and-color-survive-new-descendants`, async () => {
      const data = await fixture();
      try {
        const child = await related(data);
        const initial = await groupOf([data.ids[0], child.id]);
        assertGenerated(initial.group.title);
        const before = await nativeMetadata(child.id, { name: title, color: "pink", saveOnWindowClose: false });
        const descendant = await related(data, child.id);
        await groupOf([data.ids[0], child.id, descendant.id], { named: false });
        assert.deepEqual(await settledMetadata(descendant.id), before);
      } finally { await remove(data); }
    });
  }

  await test("late-parent-reuse-keeps-generated-identity-without-naming-hook", async () => {
    const data = await fixture(2);
    try {
      const child = await related(data, data.ids[1]);
      const initial = await groupOf([data.ids[1], child.id]);
      assertGenerated(initial.group.title);
      const before = await nativeMetadata(child.id, { collapsed: true, color: "orange", saveOnWindowClose: false });
      const result = await driver.addon(addonId, async (browser, data, childId) => {
        const { createStacker } = await import(browser.runtime.getURL("stacker.js"));
        let created = 0;
        const errors = [];
        const stacker = createStacker(browser, {
          onGroupCreated: async () => { created++; },
          onError: error => errors.push(String(error)),
        });
        await stacker.enqueue({ tabId: childId, sourceTabId: data.ids[1], windowId: data.windowId });
        await stacker.enqueue({ tabId: data.ids[1], sourceTabId: data.ids[0], windowId: data.windowId });
        await stacker.idle();
        return { created, errors, tabs: await Promise.all([...data.ids, childId].map(id => browser.tabs.get(id))) };
      }, data, child.id);
      assert.equal(result.created, 0);
      assert.deepEqual(result.errors, []);
      assert.ok(result.tabs.every(tab => tab.groupId === initial.group.id));
      assert.deepEqual(await settledMetadata(data.ids[0]), before);
    } finally { await remove(data); }
  });

  await test("concurrent-families-across-normal-windows-have-distinct-names", async () => {
    const windows = [await fixture(4), await fixture(4)];
    try {
      const pairs = await driver.addon(addonId, async (browser, windows) => Promise.all(windows.flatMap(data =>
        data.ids.map(async sourceId => [sourceId, (await browser.tabs.create({
          openerTabId: sourceId, windowId: data.windowId, active: false,
        })).id]))), windows);
      const groups = [];
      for (const pair of pairs) groups.push((await groupOf(pair)).group);
      for (const group of groups) assertGenerated(group.title);
      assert.equal(new Set(groups.map(group => group.id)).size, pairs.length);
      assert.equal(new Set(groups.map(group => group.title)).size, pairs.length);
      return { titles: groups.map(group => group.title) };
    } finally { for (const data of windows) await remove(data); }
  });

  await test("private-creation-with-normal-focus-and-separated-history", async () => {
    const normal = await fixture();
    const privateWindow = await fixture(1, true);
    try {
      const normalChild = await related(normal);
      const normalGroup = (await groupOf([normal.ids[0], normalChild.id])).group;
      const child = await related(privateWindow);
      const result = await groupOf([privateWindow.ids[0], child.id]);
      assertGenerated(result.group.title);
      assert.ok(result.tabs.every(tab => tab.incognito && tab.windowId === privateWindow.windowId));
      const records = await history([
        { key: "naming.normal", name: normalGroup.title, windowId: normal.windowId },
        { key: "naming.private", name: result.group.title, windowId: privateWindow.windowId },
      ]);
      assert.ok(records["naming.normal"].every(item => item.windowId !== privateWindow.windowId));
      assert.ok(records["naming.private"].every(item => item.windowId !== normal.windowId));
      assert.ok(records["naming.normal"].length <= 64 && records["naming.private"].length <= 64);
      const focused = await driver.addon(addonId, async browser => (await browser.windows.getLastFocused()).incognito);
      assert.equal(focused, false);
      return { normalName: normalGroup.title, privateName: result.group.title };
    } finally { await remove(privateWindow); await remove(normal); }
  });

  await test("event-page-suspension-preserves-native-title-and-session-history", async () => {
    const data = await fixture();
    try {
      const child = await related(data);
      const group = (await groupOf([data.ids[0], child.id])).group;
      const before = await nativeMetadata(child.id);
      const stored = await history([{ key: "naming.normal", name: group.title, windowId: data.windowId }]);
      assert.equal(await driver.suspendAddon(addonId), "stopped");
      assert.deepEqual(await nativeMetadata(child.id), before);
      const siblingId = await driver.chrome(sourceId => {
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        const source = ExtensionParent.apiManager.global.tabTracker.getTab(sourceId);
        const tab = source.documentGlobal.gBrowser.addTab("about:blank", {
          openerBrowser: source.linkedBrowser, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        return ExtensionParent.apiManager.global.tabTracker.getId(tab);
      }, data.ids[0]);
      const awakened = await driver.chrome(async id => {
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        const extension = ExtensionParent.GlobalManager.getExtension(id);
        for (let attempt = 0; attempt < 200; attempt++) {
          if (extension.backgroundState === "running") return true;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return false;
      }, addonId);
      assert.equal(awakened, true, "The native creation event must wake the background without the driver waking it");
      await groupOf([data.ids[0], child.id, siblingId]);
      assert.deepEqual(await settledMetadata(siblingId), before);
      assert.deepEqual(await history(), stored);
    } finally { await remove(data); }
  });

  await test("closing-private-window-removes-its-recent-names", async () => {
    const data = await fixture(1, true);
    let closed = false;
    try {
      const child = await related(data);
      const group = (await groupOf([data.ids[0], child.id])).group;
      await history([{ key: "naming.private", name: group.title, windowId: data.windowId }]);
      await remove(data);
      closed = true;
      const stored = await driver.addon(addonId, async (browser, windowId) => {
        for (let attempt = 0; attempt < 300; attempt++) {
          const result = await browser.storage.session.get("naming.private");
          if (!result["naming.private"]?.some(item => item.windowId === windowId)) return result;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error("Private history survived its window closure");
      }, data.windowId);
      assert.deepEqual(stored, {}, "There are no other private windows in this isolated test");
    } finally { if (!closed) await remove(data); }
  });

  await test("extension-reload-keeps-native-names-and-avoids-live-collisions", async () => {
    const data = await fixture(2);
    try {
      const child = await related(data);
      const group = (await groupOf([data.ids[0], child.id])).group;
      const before = await nativeMetadata(child.id, { collapsed: true, color: "cyan" });
      await driver.chrome(async id => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        await (await AddonManager.getAddonByID(id)).reload();
      }, addonId);
      assert.deepEqual(await nativeMetadata(child.id), before);
      const other = await related(data, data.ids[1]);
      const next = (await groupOf([data.ids[1], other.id])).group;
      assertGenerated(next.title);
      assert.notEqual(next.title, group.title);
      assert.deepEqual(await settledMetadata(child.id), before);
    } finally { await remove(data); }
  });

  await test("popup-full-labels-literal-component-search-and-permissionless-copy", async () => {
    const data = await fixture(3);
    const fullTitle = `literal.[group]+? <img> — 日本語 ${"long research name ".repeat(8)}`;
    try {
      const child = await related(data);
      const generated = (await groupOf([data.ids[0], child.id])).group;
      const manualId = await driver.addon(addonId, async (browser, data, title) => {
        const id = await browser.tabs.group({ tabIds: data.ids[1], createProperties: { windowId: data.windowId } });
        await browser.tabGroups.update(id, { title });
        return id;
      }, data, fullTitle);
      const popup = await openPopup(data);
      const rendered = await driver.tab(popup.id, () => [...document.querySelectorAll("#groups .group-name")]
        .map(node => ({ text: node.textContent, children: node.children.length })));
      assert.ok(rendered.some(item => item.text === fullTitle && item.children === 0), "Manual label must remain full literal text");
      for (const term of generated.title.split("-")) {
        const names = await driver.tab(popup.id, term => {
          const input = document.querySelector("#search");
          input.value = term.toUpperCase();
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return [...document.querySelectorAll("#groups .group:not([hidden]) .group-name")].map(node => node.textContent);
        }, term);
        assert.ok(names.includes(generated.title), "Both components must find the generated label regardless of case");
      }
      const literal = await driver.tab(popup.id, () => {
        const input = document.querySelector("#search");
        input.value = ".[group]+?";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return [...document.querySelectorAll("#groups .group:not([hidden]) .group-name")].map(node => node.textContent);
      });
      assert.deepEqual(literal, [fullTitle]);
      await trustedClick(popup.id, `button[data-group-id="${manualId}"][data-action="copy"]`);
      const copyResult = await driver.tab(popup.id, async () => {
        const message = document.querySelector("#message");
        for (let attempt = 0; attempt < 200; attempt++) {
          if (message.textContent) return { text: message.textContent, copyFailed: message.dataset.error === "true" };
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error("Copy did not report a result");
      });
      assert.equal(copyResult.copyFailed, false, copyResult.text);
      const clipboard = await driver.chrome(() => {
        const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
        transferable.init(null);
        transferable.addDataFlavor("text/plain");
        Services.clipboard.getData(transferable, Services.clipboard.kGlobalClipboard);
        const data = {};
        transferable.getTransferData("text/plain", data);
        return data.value.QueryInterface(Ci.nsISupportsString).data;
      });
      assert.equal(clipboard, fullTitle, "Trusted copy must place the entire exact rendered name on the system clipboard");
      return { fullNameCharacters: fullTitle.length, copiedWithoutClipboardPermission: true };
    } finally { await remove(data); }
  });

  await test("popup-isolates-normal-and-private-group-labels", async () => {
    const normal = await fixture();
    const privateWindow = await fixture(1, true);
    try {
      const normalChild = await related(normal);
      const privateChild = await related(privateWindow);
      const normalGroup = (await groupOf([normal.ids[0], normalChild.id])).group;
      const privateGroup = (await groupOf([privateWindow.ids[0], privateChild.id])).group;
      for (const [data, own, other, heading] of [
        [normal, normalGroup, privateGroup, "Open groups"],
        [privateWindow, privateGroup, normalGroup, "Open private groups"],
      ]) {
        const popup = await openPopup(data);
        const result = await driver.tab(popup.id, () => ({
          heading: document.querySelector("#groups-heading").textContent,
          ids: [...document.querySelectorAll('#groups button[data-action="open"]')].map(button => Number(button.dataset.groupId)),
        }));
        assert.equal(result.heading, heading);
        assert.ok(result.ids.includes(own.id));
        assert.ok(!result.ids.includes(other.id));
      }
    } finally { await remove(privateWindow); await remove(normal); }
  });

  await test("popup-opens-the-explicitly-selected-native-group", async () => {
    const data = await fixture();
    try {
      const child = await related(data);
      const group = (await groupOf([data.ids[0], child.id])).group;
      await nativeMetadata(child.id, { collapsed: true });
      const popup = await openPopup(data);
      await trustedClick(popup.id, `button[data-group-id="${group.id}"][data-action="open"]`);
      // Switch the driver's reference back to the harness tab. This command
      // changes Marionette's reference without selecting a tab in this fixture.
      await driver.command("POST", "/window", { handle: bootstrapHandle });
      const active = await driver.addon(addonId, async (browser, windowId, groupId) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const tabs = await browser.tabs.query({ active: true, windowId });
          if (tabs[0]?.groupId === groupId) return tabs[0];
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error("Open group did not select a member of the requested native group");
      }, data.windowId, group.id);
      assert.ok([data.ids[0], child.id].includes(active.id));
      assert.equal((await nativeMetadata(active.id)).name, group.title);
    } finally { await remove(data); }
  });

  report.sourceSha256After = await sourceHash();
  assert.equal(report.sourceSha256After, report.sourceSha256, "Extension changed during the run; results need rerunning");
  report.passed = report.results.every(result => result.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (driver) {
    await driver.close();
    await writeFile(`${output}.log`, driver.logs);
  }
}
