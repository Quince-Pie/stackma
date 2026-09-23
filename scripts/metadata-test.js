import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { FirefoxDriver } from './webdriver.js';

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = resolve(argument('source') ?? 'extension');
const output = resolve(argument('output') ?? 'artifacts/metadata-tests.json');
const hash = createHash('sha256');
for (const file of (await readdir(source)).sort()) hash.update(file).update(await readFile(`${source}/${file}`));
const report = { source, sourceSha256: hash.digest('hex'), startedAt: new Date().toISOString(), results: [] };
let driver;
let addonId;

async function fixture(count, privateWindow = false) {
  return driver.addon(addonId, async (browser, count, incognito) => {
    const normal = await browser.windows.getCurrent();
    const win = await browser.windows.create({ incognito, focused: true, url: 'about:blank' });
    const ids = [win.tabs[0].id];
    for (let index = 1; index < count; index++) {
      ids.push((await browser.tabs.create({ windowId: win.id, active: false })).id);
    }
    const { createStacker } = await import(browser.runtime.getURL('stacker.js'));
    window.metadataErrors = [];
    window.metadataStacker = createStacker(browser, { onError: error => window.metadataErrors.push(String(error)) });
    if (incognito) await browser.windows.update(normal.id, { focused: true });
    return { ids, windowId: win.id };
  }, count, privateWindow);
}

async function accept(data, edges) {
  return driver.addon(addonId, async (browser, data, edges) => {
    await Promise.all(edges.map(([child, parent]) => window.metadataStacker.enqueue({
      tabId: data.ids[child], sourceTabId: data.ids[parent], windowId: data.windowId,
    })));
    await window.metadataStacker.idle();
    if (window.metadataErrors.length) throw new Error(window.metadataErrors.join('; '));
    return Promise.all(data.ids.map(id => browser.tabs.get(id)));
  }, data, edges);
}

async function nativeMetadata(tabId, properties) {
  return driver.chrome((id, properties) => {
    const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
    const group = ExtensionParent.apiManager.global.tabTracker.getTab(id).group;
    if (!group) return null;
    if (properties) Object.assign(group, properties);
    return {
      id: group.id, name: group.name, color: group.color,
      collapsed: group.collapsed, saveOnWindowClose: group.saveOnWindowClose,
    };
  }, tabId, properties);
}

async function remove(data) {
  await driver.addon(addonId, (browser, id) => browser.windows.remove(id), data.windowId);
}

async function test(name, run) {
  const started = performance.now();
  try {
    const details = await run();
    report.results.push({ name, passed: true, durationMs: performance.now() - started, details });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.results.push({ name, passed: false, durationMs: performance.now() - started, error: String(error), remoteStack: error.remoteStack });
    console.error(`FAIL ${name}: ${error}`);
  }
}

try {
  driver = await FirefoxDriver.start({ timeoutMs: 40_000, maxLifetimeMs: 300_000 });
  addonId = await driver.installAddon(source);
  report.browser = {
    version: driver.capabilities.browserVersion, buildId: driver.capabilities['moz:buildID'],
    geckodriver: driver.capabilities['moz:geckodriverVersion'], platform: driver.capabilities.platformName,
  };
  report.extraExtensions = await driver.chrome(async id => {
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    return (await AddonManager.getAddonsByTypes(['extension']))
      .filter(addon => addon.isActive && !addon.isSystem && !addon.isBuiltin && addon.id !== id)
      .map(addon => addon.id);
  }, addonId);
  assert.deepEqual(report.extraExtensions, []);

  await test('native-empty-title-expanded-default-and-palette-exhaustion', async () => {
    const data = await fixture(22);
    const palette = ['blue', 'purple', 'cyan', 'orange', 'yellow', 'pink', 'green', 'gray', 'red'];
    const colors = [];
    try {
      for (let pair = 0; pair < 11; pair++) {
        await accept(data, [[pair * 2 + 1, pair * 2]]);
        const group = await nativeMetadata(data.ids[pair * 2]);
        assert.equal(group.name, '');
        assert.equal(group.collapsed, false);
        assert.ok(palette.includes(group.color));
        if (pair < palette.length) assert.equal(group.color, palette[pair]);
        colors.push(group.color);
      }
      return { colors };
    } finally { await remove(data); }
  });

  for (const privateWindow of [false, true]) {
    await test(`late-parent-preserves-native-identity-and-all-metadata${privateWindow ? '-private-fallback' : ''}`, async () => {
      const data = await fixture(4, privateWindow);
      try {
        const initial = await accept(data, [[2, 1]]);
        const before = await nativeMetadata(data.ids[1], {
          name: 'Research — 日本語', color: 'purple', collapsed: true, saveOnWindowClose: false,
        });
        const after = await accept(data, [[1, 0]]);
        for (const index of [0, 1, 2]) assert.equal(after[index].groupId, initial[1].groupId);
        assert.equal(after[3].groupId, -1);
        assert.deepEqual(await nativeMetadata(data.ids[0]), before);
        const edited = await nativeMetadata(data.ids[0], { name: '', color: 'gray', collapsed: false });
        await accept(data, [[3, 0]]);
        assert.deepEqual(await nativeMetadata(data.ids[3]), edited);
        return { metadata: before };
      } finally { await remove(data); }
    });
  }

  await test('existing-opener-metadata-takes-precedence-over-child-branch', async () => {
    const data = await fixture(4);
    try {
      await accept(data, [[2, 1]]);
      await nativeMetadata(data.ids[1], { name: 'Child', color: 'red', collapsed: false });
      const parentId = await driver.addon(addonId, (browser, data) => browser.tabs.group({
        tabIds: data.ids[0], createProperties: { windowId: data.windowId },
      }), data);
      const before = await nativeMetadata(data.ids[0], { name: 'Parent', color: 'gray', collapsed: true });
      const tabs = await accept(data, [[1, 0]]);
      for (const index of [0, 1, 2]) assert.equal(tabs[index].groupId, parentId);
      assert.deepEqual(await nativeMetadata(data.ids[0]), before);
    } finally { await remove(data); }
  });

  await test('foreign-child-group-member-is-not-merged-with-ungrouped-opener', async () => {
    const data = await fixture(4);
    try {
      const initial = await accept(data, [[2, 1]]);
      await driver.addon(addonId, (browser, data, groupId) => browser.tabs.group({
        groupId, tabIds: data.ids[3],
      }), data, initial[1].groupId);
      const before = await nativeMetadata(data.ids[1], { name: 'Unrelated member keeps this', color: 'orange', collapsed: true });
      const tabs = await accept(data, [[1, 0]]);
      assert.notEqual(tabs[0].groupId, initial[1].groupId);
      assert.equal(tabs[1].groupId, tabs[0].groupId);
      assert.equal(tabs[2].groupId, tabs[0].groupId);
      assert.equal(tabs[3].groupId, initial[1].groupId);
      assert.deepEqual(await nativeMetadata(data.ids[3]), before);
    } finally { await remove(data); }
  });

  for (const privateWindow of [false, true]) {
    await test(`exclusive-child-split-companion-preserves-group-metadata${privateWindow ? '-private-fallback' : ''}`, async () => {
      const data = await fixture(4, privateWindow);
      try {
        const splitId = await driver.chrome(ids => {
          const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
          const [child, companion] = [ids[1], ids[3]].map(id => ExtensionParent.apiManager.global.tabTracker.getTab(id));
          return child.documentGlobal.gBrowser.addTabSplitView([child, companion], { insertBefore: child }).splitViewId;
        }, data.ids);
        const initial = await accept(data, [[2, 1]]);
        assert.equal(initial[3].groupId, initial[1].groupId, 'native split companion joined the child branch');
        const before = await nativeMetadata(data.ids[1], { name: 'Split family', color: 'cyan', collapsed: true });
        const tabs = await accept(data, [[1, 0]]);
        for (const tab of tabs) assert.equal(tab.groupId, initial[1].groupId);
        assert.equal(tabs[1].splitViewId, splitId);
        assert.equal(tabs[3].splitViewId, splitId);
        assert.deepEqual(await nativeMetadata(data.ids[0]), before);
      } finally { await remove(data); }
    });
  }

  await test('native-new-tab-insertion-controls-collapse-without-metadata-overwrite', async () => {
    const data = await fixture(2);
    try {
      const initial = await accept(data, [[1, 0]]);
      const before = await nativeMetadata(data.ids[0], { name: 'Native visibility', color: 'pink', collapsed: true });
      const child = await driver.addon(addonId, (browser, data) => browser.tabs.create({
        openerTabId: data.ids[0], windowId: data.windowId, active: false,
      }), data);
      assert.equal(child.groupId, initial[0].groupId);
      const after = await nativeMetadata(data.ids[0]);
      assert.equal(after.id, before.id);
      assert.equal(after.name, before.name);
      assert.equal(after.color, before.color);
      assert.equal(after.collapsed, false, 'Firefox expands a collapsed group when inserting a new inherited tab');
    } finally { await remove(data); }
  });

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
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  if (driver) {
    await driver.close();
    await writeFile(`${output}.log`, driver.logs);
  }
}
