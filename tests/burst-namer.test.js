import test from "node:test";
import assert from "node:assert/strict";
// The production namer's semantic checks also apply to this experimental path.
import { createNamer } from "../experiments/burst-namer.js";
import { createStacker } from "../extension/stacker.js";
import { createModel } from "./model.js";

// Independent native metadata/session model. Every method crosses an async
// boundary, and events can be delivered before a write's promise settles.
function fixture() {
  const groups = new Map();
  const windows = new Map([[1, { id: 1, incognito: false }], [2, { id: 2, incognito: false }], [3, { id: 3, incognito: true }]]);
  const data = {};
  const calls = [];
  const errors = [];
  const hooks = new Map();
  let afterWrite;
  let owner;
  const choose = titles => {
    const occupied = new Set(titles);
    let i = 1;
    while (occupied.has(`stack-${i}`)) i++;
    return { name: `stack-${i}`, kind: 'numbered', eligible: 0 };
  };
  const boundary = async (method, args) => {
    calls.push({ method, args: structuredClone(args) });
    await hooks.get(method)?.(args);
  };
  const api = {
    windows: { async getAll() { await boundary('windows', []); return structuredClone([...windows.values()]); } },
    tabGroups: {
      async get(id) {
        await boundary('get', [id]);
        if (!groups.has(id)) throw new Error(`No group with id: ${id}`);
        return structuredClone(groups.get(id));
      },
      async query(query) { await boundary('query', [query]); return structuredClone([...groups.values()]); },
      async update(id, changes) {
        await boundary('update', [id, changes]);
        if (!groups.has(id)) throw new Error(`No group with id: ${id}`);
        Object.assign(groups.get(id), changes);
        owner.updated(structuredClone(groups.get(id)));
        await afterWrite?.();
        return structuredClone(groups.get(id));
      },
    },
    storage: { session: {
      async get(key) { await boundary('storage.get', [key]); return structuredClone({ [key]: data[key] }); },
      async set(values) { await boundary('storage.set', [values]); Object.assign(data, structuredClone(values)); },
      async remove(key) { await boundary('storage.remove', [key]); delete data[key]; },
    } },
  };
  const make = options => owner = createNamer(api, { choose, onError: error => errors.push(error), ...options });
  return {
    api, groups, windows, data, calls, errors, hooks, make,
    add(id, windowId = 1, title = '') { groups.set(id, { id, windowId, title, color: 'purple', collapsed: true, saveOnWindowClose: true }); },
    edit(id, changes) { Object.assign(groups.get(id), changes); owner.updated({ ...groups.get(id) }); },
    hold(method) {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      hooks.set(method, async () => { hooks.delete(method); entered.resolve(); await release.promise; });
      return { entered: entered.promise, release: release.resolve };
    },
    afterWrite(fn) { afterWrite = fn; },
  };
}

test('new names write only title and preserve large native IDs and every other property', async () => {
  const f = fixture(), id = 1_750_000_000_000_001;
  f.add(id);
  const before = { ...f.groups.get(id) };
  await f.make().enqueue(id, 1, false);
  assert.deepEqual(f.groups.get(id), { ...before, title: 'stack-1' });
  assert.deepEqual(f.calls.filter(call => call.method === 'update').map(call => call.args), [[id, { title: 'stack-1' }]]);
  assert.equal(f.errors.length, 0);
});

test('one privacy lane reserves unique names across simultaneous windows and duplicate enqueue', async () => {
  const f = fixture(); f.add(10); f.add(20, 2);
  const n = f.make();
  const a = n.enqueue(10, 1, false), duplicate = n.enqueue(10, 1, false);
  assert.equal(a, duplicate);
  await Promise.all([a, n.enqueue(20, 2, false)]);
  assert.equal(f.groups.get(10).title, 'stack-1');
  assert.equal(f.groups.get(20).title, 'stack-2');
  assert.equal(f.calls.filter(call => call.method === 'update').length, 2);
});

test('normal/private contexts and histories stay separate; native titles never enter history', async () => {
  const f = fixture(); f.add(10); f.add(20, 3); f.add(30, 1, 'manual-private-looking-text');
  const n = f.make();
  await Promise.all([n.enqueue(10, 1, false), n.enqueue(20, 3, true)]);
  assert.equal(f.groups.get(10).title, 'stack-1');
  assert.equal(f.groups.get(20).title, 'stack-1');
  assert.deepEqual(f.data['naming.normal'], [{ name: 'stack-1', windowId: 1 }]);
  assert.deepEqual(f.data['naming.private'], [{ name: 'stack-1', windowId: 3 }]);
});

test('already named and missing groups do not allocate or write', async () => {
  const f = fixture(); f.add(10, 1, 'My work');
  const n = f.make();
  await n.enqueue(10, 1, false); await n.enqueue(11, 1, false);
  assert.equal(f.calls.filter(call => call.method !== 'get').length, 0);
  assert.equal(f.errors.length, 0);
});

test('duplicate native IDs never transfer naming authority to a different group', async () => {
  for (const otherWindowId of [1, 2, 3]) {
    const f = fixture(); f.add(10);
    const query = f.api.tabGroups.query;
    f.api.tabGroups.query = async options => [...await query(options), { ...f.groups.get(10), windowId: otherWindowId }];
    await f.make().enqueue(10, 1, false);
    assert.equal(f.groups.get(10).title, '');
    assert.equal(f.calls.filter(call => ['update', 'storage.set'].includes(call.method)).length, 0);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0].message, /ambiguous group ID/);
  }
});

test('another native creation reusing a pending ID cancels its assignment', async () => {
  const f = fixture(); f.add(10);
  const n = f.make(), hold = f.hold('storage.set');
  const done = n.enqueue(10, 1, false);
  await hold.entered;
  n.created({ ...f.groups.get(10) });
  hold.release(); await done;
  assert.equal(f.groups.get(10).title, '');
  assert.equal(f.calls.filter(call => call.method === 'update').length, 0);
  assert.equal(f.errors.length, 1);
});

test('observed rename then clear while context IPC waits permanently cancels that attempt', async () => {
  const f = fixture(); f.add(10);
  const n = f.make(), hold = f.hold('query');
  const done = n.enqueue(10, 1, false);
  await hold.entered;
  f.edit(10, { title: 'My choice' }); f.edit(10, { title: '' }); hold.release();
  await done;
  assert.equal(f.groups.get(10).title, '');
  assert.equal(f.calls.filter(call => call.method === 'update').length, 0);
});

test('observed color/collapse-only updates do not cancel a name', async () => {
  const f = fixture(); f.add(10);
  const n = f.make(), hold = f.hold('query');
  const done = n.enqueue(10, 1, false);
  await hold.entered;
  f.edit(10, { color: 'red', collapsed: false }); hold.release(); await done;
  assert.deepEqual(f.groups.get(10), { id: 10, windowId: 1, title: 'stack-1', color: 'red', collapsed: false, saveOnWindowClose: true });
});

for (const event of ['remove', 'move', 'rename']) {
  test(`final fresh read/cancellation respects a ${event} during reservation`, async () => {
    const f = fixture(); f.add(10);
    const n = f.make(), hold = f.hold('storage.set');
    const done = n.enqueue(10, 1, false);
    await hold.entered;
    if (event === 'remove') { n.removed(f.groups.get(10)); f.groups.delete(10); }
    if (event === 'move') { f.groups.get(10).windowId = 2; n.moved(f.groups.get(10)); }
    if (event === 'rename') f.edit(10, { title: 'Manual' });
    hold.release(); await done;
    assert.equal(f.calls.filter(call => call.method === 'update').length, 0);
    assert.equal(f.errors.length, 0);
  });
}

test('a storage failure leaves grouping/name untouched, reports once, and does not poison the next job', async () => {
  const f = fixture(); f.add(10); f.add(20);
  const n = f.make();
  f.hooks.set('storage.set', () => { f.hooks.delete('storage.set'); throw new Error('quota'); });
  await n.enqueue(10, 1, false); await n.enqueue(20, 1, false);
  assert.equal(f.groups.get(10).title, '');
  assert.equal(f.groups.get(20).title, 'stack-1');
  assert.equal(f.errors.length, 1);
});

test('title failures retry at most once, after reading native authority again', async () => {
  const f = fixture(); f.add(10);
  f.hooks.set('update', () => { throw new Error('injected title failure'); });
  await f.make().enqueue(10, 1, false);
  assert.equal(f.calls.filter(call => call.method === 'update').length, 2);
  assert.equal(f.errors.length, 1);
  assert.equal(f.groups.get(10).title, '');
});

test('a write applied before IPC rejects is recognized without writing twice', async () => {
  const f = fixture(); f.add(10);
  f.afterWrite(() => { throw new Error('reply lost'); });
  await f.make().enqueue(10, 1, false);
  assert.equal(f.groups.get(10).title, 'stack-1');
  assert.equal(f.calls.filter(call => call.method === 'update').length, 1);
  assert.equal(f.errors.length, 0);
});

test('an observed committed name followed by manual clearing is never restored after a lost reply', async () => {
  const f = fixture(); f.add(10);
  f.afterWrite(() => { f.edit(10, { title: '' }); throw new Error('reply lost after manual clear'); });
  await f.make().enqueue(10, 1, false);
  assert.equal(f.groups.get(10).title, '');
  assert.equal(f.calls.filter(call => call.method === 'update').length, 1);
  assert.equal(f.errors.length, 0);
});

test('recent history is bounded and rehydrated after a new event-page instance', async () => {
  const f = fixture();
  f.data['naming.normal'] = Array.from({ length: 64 }, (_, i) => ({ name: `stack-${i + 1}`, windowId: 2 }));
  f.add(10);
  await f.make().enqueue(10, 1, false);
  assert.equal(f.groups.get(10).title, 'stack-65');
  assert.equal(f.data['naming.normal'].length, 64);
  f.groups.delete(10); f.add(11);
  await f.make().enqueue(11, 1, false);
  assert.equal(f.groups.get(11).title, 'stack-1'); // oldest fell outside the declared horizon
  assert.equal(f.data['naming.normal'].length, 64);
});

test('private closure cleanup is serialized after an in-flight reservation and preserves other windows', async () => {
  const f = fixture(); f.windows.set(4, { id: 4, incognito: true });
  f.data['naming.private'] = [{ name: 'stack-1', windowId: 4 }];
  f.add(10, 3);
  const n = f.make(), hold = f.hold('storage.set');
  const done = n.enqueue(10, 3, true);
  await hold.entered;
  f.windows.delete(3); f.groups.delete(10);
  const closed = n.closedWindow(3);
  hold.release(); await Promise.all([done, closed]);
  assert.deepEqual(f.data['naming.private'], [{ name: 'stack-1', windowId: 4 }]);
  await n.closedWindow(4);
  assert.equal(f.data['naming.private'], undefined);
  assert.equal(f.errors.length, 0);
});

test('closed private windows and malformed/oversized session data cannot enter a later context', async () => {
  const f = fixture(); f.add(10, 3);
  f.data['naming.private'] = [{ name: 'stack-1', windowId: 99 }, null, { name: 'not a generated alias', windowId: 3 }];
  await f.make().enqueue(10, 3, true);
  assert.equal(f.groups.get(10).title, 'stack-1');
  assert.deepEqual(f.data['naming.private'], [{ name: 'stack-1', windowId: 3 }]);
});

test('a naming failure cannot retry successful native grouping', async () => {
  const m = createModel([{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }]);
  const errors = [], names = [];
  const s = createStacker(m.api, { onError: e => errors.push(e), onGroupCreated: async (...args) => { names.push(args); throw new Error('naming failed'); } });
  await s.enqueue({ tabId: 2, sourceTabId: 1, windowId: 1 }); await s.idle();
  assert.equal(m.calls.filter(call => call.method === 'group').length, 1);
  assert.deepEqual(names, [[m.tab(1).groupId, 1, false]]);
  assert.equal(errors.length, 1);
  assert.equal(m.tab(1).groupId, m.tab(2).groupId);
});

test('a lost group-creation reply preserves the unowned title and reports ambiguous naming authority', async () => {
  const m = createModel([{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }]);
  const nativeGroup = m.api.tabs.group;
  m.api.tabs.group = async options => { await nativeGroup(options); throw new Error('creation reply lost'); };
  const errors = [], names = [];
  const s = createStacker(m.api, { onError: e => errors.push(e), onGroupCreated: async (...args) => { names.push(args); } });
  await s.enqueue({ tabId: 2, sourceTabId: 1, windowId: 1 });
  assert.equal(m.calls.filter(call => call.method === 'group').length, 1);
  assert.equal(m.tab(1).groupId, m.tab(2).groupId);
  assert.equal(m.group(m.tab(1).groupId).title, '');
  assert.deepEqual(names, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /did not confirm creation/);
});

test('slow naming keeps completion alive while independent membership work in the window continues', async () => {
  const m = createModel([1, 2, 3, 4].map(id => ({ id, windowId: 1 })));
  const hold = Promise.withResolvers(), started = Promise.withResolvers();
  const s = createStacker(m.api, { onGroupCreated: async () => { started.resolve(); await hold.promise; } });
  let finished = false;
  const first = s.enqueue({ tabId: 2, sourceTabId: 1, windowId: 1 }).then(() => finished = true);
  const second = s.enqueue({ tabId: 4, sourceTabId: 3, windowId: 1 });
  await started.promise;
  for (let i = 0; i < 100 && m.groupIds().length < 2; i++) await Promise.resolve();
  assert.equal(m.groupIds().length, 2);
  assert.equal(finished, false);
  hold.resolve(); await Promise.all([first, second, s.idle()]);
  assert.equal(finished, true);
});

test('joining and late-parent reuse never schedule a new name', async () => {
  const m = createModel([{ id: 1, windowId: 1 }, { id: 2, windowId: 1, groupId: 7 }, { id: 3, windowId: 1, groupId: 7 }, { id: 4, windowId: 1 }]);
  const names = [];
  const s = createStacker(m.api, { onGroupCreated: async (...args) => { names.push(args); } });
  await s.enqueue({ tabId: 3, sourceTabId: 2, windowId: 1 });
  await s.enqueue({ tabId: 2, sourceTabId: 1, windowId: 1 });
  await s.enqueue({ tabId: 4, sourceTabId: 1, windowId: 1 });
  assert.deepEqual(names, []);
  assert.ok(m.tabs().every(tab => tab.groupId === 7));
});

test('burst snapshot is shared across queued jobs and released at idle', async () => {
  const f = fixture();
  for (let id = 10; id < 90; id++) f.add(id, id % 2 + 1);
  const n = f.make();
  await Promise.all([...f.groups.values()].map(group => n.enqueue(group.id, group.windowId, false)));
  assert.equal(f.calls.filter(call => call.method === 'query').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'windows').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'storage.get').length, 80);
  assert.equal(new Set([...f.groups.values()].map(group => group.title)).size, 80,
    'native titles remain occupied beyond the 64-entry recent history');
  assert.deepEqual(n.diagnostics(), { queued: 0, contexts: 0, cachedGroups: 0 });
  f.add(100);
  await n.enqueue(100, 1, false);
  assert.equal(f.calls.filter(call => call.method === 'query').length, 2);
  assert.deepEqual(n.diagnostics(), { queued: 0, contexts: 0, cachedGroups: 0 });
});

test('external rename invalidates a burst before the next allocation', async () => {
  const f = fixture(); f.add(10); f.add(20); f.add(30, 1, 'stack-1');
  const n = f.make(), hold = f.hold('update');
  const jobs = [n.enqueue(10, 1, false), n.enqueue(20, 1, false)];
  await hold.entered;
  assert.equal(n.diagnostics().contexts, 1);
  f.edit(30, { title: 'stack-3' });
  assert.equal(n.diagnostics().contexts, 0);
  hold.release(); await Promise.all(jobs);
  assert.equal(f.groups.get(10).title, 'stack-2');
  assert.equal(f.groups.get(20).title, 'stack-1');
  assert.equal(f.calls.filter(call => call.method === 'query').length, 2);
});

for (const event of ['create', 'remove', 'move', 'window-create']) {
  test(`external ${event} invalidates a retained context`, async () => {
    const f = fixture(); f.add(10); f.add(20);
    const n = f.make(), hold = f.hold('update');
    const jobs = [n.enqueue(10, 1, false), n.enqueue(20, 1, false)];
    await hold.entered;
    if (event === 'create') { f.add(30, 1, 'stack-2'); n.created(f.groups.get(30)); }
    if (event === 'remove') n.removed({ id: 99, windowId: 1, title: 'old' });
    if (event === 'move') n.moved({ id: 99, windowId: 2, title: 'moved' });
    if (event === 'window-create') { f.windows.set(4, { id: 4, incognito: false }); n.windowCreated(f.windows.get(4)); }
    assert.equal(n.diagnostics().contexts, 0);
    hold.release(); await Promise.all(jobs);
    assert.equal(f.calls.filter(call => call.method === 'query').length, 2);
    if (event === 'create') assert.equal(f.groups.get(20).title, 'stack-3');
  });
}

test('a context invalidated during its native query cannot be reused', async () => {
  const f = fixture(); f.add(10); f.add(20);
  const n = f.make(), hold = f.hold('query');
  const jobs = [n.enqueue(10, 1, false), n.enqueue(20, 1, false)];
  await hold.entered;
  f.add(30, 1, 'stack-1'); n.created(f.groups.get(30));
  hold.release(); await Promise.all(jobs);
  assert.equal(f.calls.filter(call => call.method === 'query').length, 2);
  assert.equal(f.groups.get(10).title, 'stack-2');
  assert.equal(f.groups.get(20).title, 'stack-3');
});

test('uncommitted reservations are not permanent occupied entries in a burst', async () => {
  const f = fixture();
  for (let id = 10; id < 77; id++) f.add(id);
  const n = f.make();
  f.hooks.set('update', () => { throw new Error('No write committed'); });
  await Promise.all([...f.groups.values()].map(group => n.enqueue(group.id, 1, false)));
  const attempts = f.calls.filter(call => call.method === 'update');
  assert.equal(attempts[0].args[1].title, 'stack-1');
  assert.equal(attempts[130].args[1].title, 'stack-1', 'after 65 reservations the oldest slot may be reused');
  assert.equal(f.calls.filter(call => call.method === 'query').length, 1);
  assert.equal(f.errors.length, 67);
  assert.ok([...f.groups.values()].every(group => group.title === ''));
  assert.deepEqual(n.diagnostics(), { queued: 0, contexts: 0, cachedGroups: 0 });
});

test('failed context reads release state and do not poison the remaining burst', async () => {
  const f = fixture(); f.add(10); f.add(20);
  const n = f.make();
  f.hooks.set('query', () => { f.hooks.delete('query'); throw new Error('Transient context failure'); });
  await Promise.all([n.enqueue(10, 1, false), n.enqueue(20, 1, false)]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.groups.get(10).title, '');
  assert.equal(f.groups.get(20).title, 'stack-1');
  assert.deepEqual(n.diagnostics(), { queued: 0, contexts: 0, cachedGroups: 0 });
});

test('new empty groups invalidate context because native identity can collide', async () => {
  const f = fixture(); f.add(10); f.add(20);
  const n = f.make(), hold = f.hold('storage.set');
  const jobs = [n.enqueue(10, 1, false), n.enqueue(20, 1, false)];
  await hold.entered;
  f.add(30); n.created(f.groups.get(30));
  hold.release(); await Promise.all(jobs);
  assert.equal(f.calls.filter(call => call.method === 'query').length, 2);
  assert.equal(f.groups.get(10).title, 'stack-1');
  assert.equal(f.groups.get(20).title, 'stack-2');
});

test('all colliding other-group titles remain occupied throughout a burst', async () => {
  const f = fixture(); f.add(10); f.add(20); f.add(30, 1, 'stack-1');
  const query = f.api.tabGroups.query;
  f.api.tabGroups.query = async options => [...await query(options), { ...f.groups.get(30), title: 'stack-2' }];
  const n = f.make();
  await Promise.all([n.enqueue(10, 1, false), n.enqueue(20, 1, false)]);
  assert.equal(f.groups.get(10).title, 'stack-3');
  assert.equal(f.groups.get(20).title, 'stack-4');
  assert.equal(f.calls.filter(call => call.method === 'query').length, 1);
  assert.equal(f.errors.length, 0);
  assert.deepEqual(n.diagnostics(), { queued: 0, contexts: 0, cachedGroups: 0 });
});

test('an empty creation colliding with a queued target cancels it before a cached write', async () => {
  const f = fixture(); f.add(10); f.add(20);
  const n = f.make(), hold = f.hold('update');
  const jobs = [n.enqueue(10, 1, false), n.enqueue(20, 1, false)];
  await hold.entered;
  n.created({ ...f.groups.get(20), windowId: 3 });
  n.created({ ...f.groups.get(20), windowId: 3 });
  hold.release(); await Promise.all(jobs);
  assert.equal(f.groups.get(10).title, 'stack-1');
  assert.equal(f.groups.get(20).title, '');
  assert.equal(f.calls.filter(call => call.method === 'update').length, 1);
  assert.equal(f.errors.length, 1, 'one report per cancelled attempt');
});
