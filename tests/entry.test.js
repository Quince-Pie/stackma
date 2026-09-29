import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createModel } from './model.js';

// Each browser's entry decides which native event is link provenance. The
// shared core, stacker and namer are exercised through the same small model.
function event() {
  const listeners = [];
  return { listeners, addListener: listener => listeners.push(listener), emit: (...args) => listeners.map(listener => listener(...args)) };
}

function fakeBrowser(model) {
  const session = new Map();
  const badge = [];
  const group = id => {
    const value = model.group(id);
    if (!value) throw new Error(`No group with id: ${id}`);
    return { id, windowId: value.windowId, title: value.title, color: value.color, collapsed: value.collapsed };
  };
  const api = {
    action: {
      setBadgeText: async ({ text }) => { badge.push(text); },
      setBadgeBackgroundColor: async () => {},
    },
    storage: { session: {
      get: async key => (session.has(key) ? { [key]: structuredClone(session.get(key)) } : {}),
      set: async values => { for (const [key, value] of Object.entries(values)) session.set(key, structuredClone(value)); },
      remove: async key => { session.delete(key); },
    } },
    windows: {
      getAll: async () => [...new Map(model.tabs().map(tab => [tab.windowId, { id: tab.windowId, incognito: tab.incognito }])).values()],
      onCreated: event(), onRemoved: event(),
    },
    tabGroups: {
      get: async id => group(id),
      query: async () => model.groupIds().map(group),
      update: async (id, { title }) => { model.setGroupMetadata(id, { title }); return group(id); },
      onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(),
    },
    tabs: { ...model.api.tabs, onCreated: event(), onRemoved: event() },
    webNavigation: { onCreatedNavigationTarget: event() },
  };
  return { api, badge, session };
}

async function until(predicate, description) {
  for (let turn = 0; turn < 2_000; turn++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function settleTurns(count = 200) {
  for (let turn = 0; turn < count; turn++) await new Promise(resolve => setImmediate(resolve));
}

let loads = 0;
async function loadFirefox(api) {
  globalThis.browser = api;
  await import(`../extension/background.js?instance=${++loads}`);
}

// Assemble the Chrome package layout: shared modules plus Chrome's entry.
async function loadChrome(api) {
  const directory = await mkdtemp(join(tmpdir(), 'tab-gantry-chrome-entry-'));
  try {
    for (const root of ['extension', 'chrome/extension']) {
      for (const name of await readdir(root)) if (name.endsWith('.js')) await copyFile(join(root, name), join(directory, name));
    }
    globalThis.browser = api;
    await import(`${pathToFileURL(join(directory, 'service-worker.js')).href}?instance=${++loads}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const tabs = () => [{ id: 1, windowId: 1, index: 0 }, { id: 2, windowId: 1, index: 1 }];

test('Firefox groups and names a tab from its reported opener', async () => {
  const model = createModel(tabs());
  const { api, badge } = fakeBrowser(model);
  await loadFirefox(api);
  assert.equal(api.tabs.onCreated.listeners.length, 1);
  assert.equal(api.webNavigation.onCreatedNavigationTarget.listeners.length, 1);
  api.tabs.onCreated.emit({ id: 2, openerTabId: 1, windowId: 1 });
  await until(() => model.tab(2).groupId !== -1 && model.group(model.tab(2).groupId)?.title, 'a named group');
  assert.equal(model.tab(1).groupId, model.tab(2).groupId);
  assert.match(model.group(model.tab(1).groupId).title, /^[a-z]+-[a-z]+$/u);
  assert.deepEqual(badge, []);
});

test('Chrome ignores activation-derived openers such as Ctrl+T', async () => {
  const model = createModel(tabs());
  const { api } = fakeBrowser(model);
  await loadChrome(api);
  assert.equal(api.tabs.onCreated.listeners.length, 0, 'Chrome openerTabId must not start a relationship');
  assert.equal(api.webNavigation.onCreatedNavigationTarget.listeners.length, 1);
  api.tabs.onCreated.emit({ id: 2, openerTabId: 1, windowId: 1 });
  await settleTurns();
  assert.deepEqual(model.calls.filter(call => call.method !== 'get'), []);
  assert.equal(model.tab(2).groupId, -1);
});

test('Chrome groups a navigation target in the window it reads for the new tab', async () => {
  const model = createModel(tabs());
  const { api, badge } = fakeBrowser(model);
  await loadChrome(api);
  api.webNavigation.onCreatedNavigationTarget.emit({ tabId: 2, sourceTabId: 1, sourceFrameId: 0, url: 'https://example.test/', timeStamp: 1 });
  await until(() => model.tab(2).groupId !== -1 && model.group(model.tab(2).groupId)?.title, 'a named group');
  assert.equal(model.tab(1).groupId, model.tab(2).groupId);
  assert.deepEqual(model.calls[0], { method: 'get', args: [2] }, 'the window lookup reads the new tab first');
  assert.deepEqual(badge, []);
});

test('Chrome leaves a navigation target alone when its tab closed before the lookup', async () => {
  const model = createModel(tabs());
  const { api, badge } = fakeBrowser(model);
  await loadChrome(api);
  model.failNext('get', { message: 'No tab with id: 2.' });
  api.webNavigation.onCreatedNavigationTarget.emit({ tabId: 2, sourceTabId: 1, sourceFrameId: 0, url: 'https://example.test/', timeStamp: 1 });
  await settleTurns();
  assert.deepEqual(model.calls, [{ method: 'get', args: [2] }]);
  assert.deepEqual(badge, []);
});

test('Chrome reports an unexpected window lookup failure', async () => {
  const model = createModel(tabs());
  const { api, badge } = fakeBrowser(model);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await loadChrome(api);
    model.failNext('get', new Error('Extension context invalidated'));
    api.webNavigation.onCreatedNavigationTarget.emit({ tabId: 2, sourceTabId: 1, sourceFrameId: 0, url: 'https://example.test/', timeStamp: 1 });
    await until(() => badge.includes('!'), 'the failure badge');
  } finally {
    console.error = original;
  }
  assert.equal(model.tab(2).groupId, -1);
  assert.equal(logged.length, 1);
});

test('the stacker treats Chrome and Firefox missing-tab replies alike', async () => {
  for (const message of ['Invalid tab ID: 1', 'No tab with id: 1.']) {
    const model = createModel(tabs());
    const { api, badge } = fakeBrowser(model);
    await loadFirefox(api);
    model.failNext('get', { message });
    model.failNext('get', { message });
    api.tabs.onCreated.emit({ id: 2, openerTabId: 1, windowId: 1 });
    await settleTurns();
    assert.equal(model.tab(2).groupId, -1, message);
    assert.deepEqual(badge, [], message);
  }
});
