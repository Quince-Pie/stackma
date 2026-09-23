import assert from 'node:assert/strict';
import test from 'node:test';
import { createStacker } from '../extension/stacker.js';
import { createModel } from './model.js';

const relation = (tabId, sourceTabId, windowId = 1) => ({ tabId, sourceTabId, windowId });
const tab = (id, changes = {}) => ({ id, windowId: 1, ...changes });

function fixture(tabs, options = {}, modelOptions = {}) {
  const model = createModel(tabs, modelOptions);
  const errors = [];
  const stacker = createStacker(model.api, { ...options, onError: error => errors.push(error) });
  return { model, stacker, errors };
}

function sameGroup(model, ...ids) {
  const groupId = model.tab(ids[0]).groupId;
  assert.notEqual(groupId, -1, 'a related component must have a native group');
  for (const id of ids) assert.equal(model.tab(id).groupId, groupId, `tab ${id} belongs to the component`);
  return groupId;
}

function mutations(model) {
  return model.calls.filter(call => call.method !== 'get');
}

async function settle(stacker, events) {
  await Promise.all(events.map(event => stacker.enqueue(event)));
  await stacker.idle();
}

async function beforeDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1500); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('ungrouped opener and child form a native group in their own window', async () => {
  const { model, stacker, errors } = fixture([
    tab(1, { active: true, cookieStoreId: 'firefox-container-4' }),
    tab(2, { openerTabId: 1, cookieStoreId: 'firefox-container-4' }),
    tab(3, { windowId: 2, active: true }),
  ], {}, { currentWindowId: 2 });
  await settle(stacker, [relation(2, 1)]);
  sameGroup(model, 1, 2);
  assert.equal(model.tab(3).groupId, -1);
  assert.equal(model.tab(1).windowId, 1);
  assert.equal(model.tab(2).windowId, 1);
  assert.equal(model.tab(1).active, true);
  assert.equal(model.tab(2).active, false);
  assert.equal(model.tab(2).cookieStoreId, 'firefox-container-4');
  const creation = model.calls.find(call => call.method === 'group').args[0];
  assert.deepEqual(creation.createProperties, { windowId: 1 });
  assert.deepEqual(errors, []);
});

test('child joins the opener existing group without touching unrelated groups', async () => {
  const { model, stacker } = fixture([
    tab(1, { groupId: 8 }), tab(2, { groupId: 8 }), tab(3), tab(4, { groupId: 9 }),
  ]);
  await settle(stacker, [relation(3, 1)]);
  assert.equal(sameGroup(model, 1, 2, 3), 8);
  assert.equal(model.tab(4).groupId, 9);
});

test('native inheritance that already satisfies the relation causes no mutation', async () => {
  const { model, stacker } = fixture([tab(1, { groupId: 8 }), tab(2, { groupId: 8 })]);
  const before = model.snapshot();
  await settle(stacker, [relation(2, 1)]);
  assert.deepEqual(model.snapshot(), before);
  assert.deepEqual(mutations(model), []);
});

test('missing, self, and malformed relationships cause no mutations', async () => {
  const { model, stacker } = fixture([tab(1), tab(2)]);
  await settle(stacker, [
    relation(2, undefined), relation(2, null), relation(2, -1),
    relation(2, 2), relation(-1, 1), relation(undefined, 1),
    relation(2.5, 1), relation(2, NaN), relation(2, '1'),
  ]);
  assert.deepEqual(mutations(model), []);
  assert.equal(model.tab(1).groupId, -1);
});

test('pinned endpoints are preserved and the relationship is skipped', async () => {
  for (const pinnedId of [1, 2]) {
    const { model, stacker } = fixture([tab(1, { pinned: pinnedId === 1 }), tab(2, { pinned: pinnedId === 2 })]);
    const before = model.snapshot();
    await settle(stacker, [relation(2, 1)]);
    assert.deepEqual(model.snapshot(), before);
    assert.deepEqual(mutations(model), []);
  }
});

test('relationships across windows and privacy boundaries do not move tabs', async () => {
  for (const incognito of [false, true]) {
    const { model, stacker } = fixture([tab(1), tab(2, { windowId: 2, incognito })]);
    const before = model.snapshot();
    await settle(stacker, [relation(2, 1, 2)]);
    assert.deepEqual(model.snapshot(), before);
    assert.deepEqual(mutations(model), []);
  }
});

test('private group creation uses the source window despite a normal focused window', async () => {
  const { model, stacker } = fixture([
    tab(1, { windowId: 2, incognito: true }), tab(2, { windowId: 2, incognito: true }), tab(3),
  ], {}, { currentWindowId: 1 });
  await settle(stacker, [relation(2, 1, 2)]);
  sameGroup(model, 1, 2);
  assert.equal(model.tab(3).groupId, -1);
  assert.equal(model.tab(2).incognito, true);
});

test('private existing-group joins work without focusing or crossing a window', async () => {
  for (const childFirst of [false, true]) {
    const privateTabs = [tab(1, { windowId: 2, incognito: true, groupId: 8 }), tab(2, { windowId: 2, incognito: true })];
    if (childFirst) privateTabs.reverse();
    const { model, stacker } = fixture([...privateTabs, tab(3)], {}, { currentWindowId: 1 });
    await settle(stacker, [relation(2, 1, 2)]);
    assert.equal(sameGroup(model, 1, 2), 8);
    assert.equal(model.tab(2).windowId, 2);
    assert.equal(model.tab(2).incognito, true);
    assert.equal(model.tab(3).groupId, -1);
    assert.ok(model.calls.some(call => call.method === 'move'), 'documented move is the privacy-safe fallback');
  }
});

test('private fallback recovers a transient descendant move failure', async () => {
  let failDescendant = true;
  const { model, stacker, errors } = fixture([
    tab(1, { windowId: 2, incognito: true, groupId: 8 }),
    tab(2, { windowId: 2, incognito: true }),
    tab(3, { windowId: 2, incognito: true }),
    tab(4),
  ], {}, {
    currentWindowId: 1,
    beforeCall({ method, args }) {
      if (method === 'move' && args[0] === 3 && failDescendant) {
        failDescendant = false;
        throw new Error('Transient descendant move failure');
      }
    },
  });
  await settle(stacker, [relation(3, 2, 2)]);
  await settle(stacker, [relation(2, 1, 2)]);
  assert.equal(sameGroup(model, 1, 2, 3), 8);
  assert.deepEqual(errors, []);
});

test('private fallback retains ancestry after partial success and recovery', async () => {
  let failMiddleNode = true;
  const { model, stacker, errors } = fixture([
    ...Array.from({ length: 6 }, (_, index) => tab(index + 1, {
      windowId: 2, incognito: true, ...(index === 0 ? { groupId: 8 } : {}),
    })),
    tab(7),
  ], {}, {
    currentWindowId: 1,
    beforeCall({ method, args }) {
      if (method === 'move' && args[0] === 3 && failMiddleNode) {
        failMiddleNode = false;
        throw new Error('Transient interior-node move failure');
      }
    },
  });
  await settle(stacker, [relation(3, 2, 2), relation(4, 2, 2), relation(5, 3, 2)]);
  await settle(stacker, [relation(2, 1, 2)]);
  assert.equal(sameGroup(model, 1, 2, 3, 4, 5), 8);
  // Successful descendants must remain represented after the recovery. A later
  // parent merge exposes records accidentally left with their old group IDs.
  await settle(stacker, [relation(1, 6, 2)]);
  sameGroup(model, 1, 2, 3, 4, 5, 6);
  assert.deepEqual(errors, []);
});

test('persistent partial private fallback is bounded and reported without stranding later work', async () => {
  const { model, stacker, errors } = fixture([
    ...Array.from({ length: 6 }, (_, index) => tab(index + 1, {
      windowId: 2, incognito: true, ...(index === 0 ? { groupId: 8 } : {}),
    })),
    tab(7),
  ], {}, {
    currentWindowId: 1,
    beforeCall({ method, args }) {
      if (method === 'move' && args[0] === 3) throw new Error('Persistent interior-node move failure');
    },
  });
  await settle(stacker, [relation(3, 2, 2), relation(4, 2, 2), relation(5, 3, 2)]);
  await beforeDeadline(stacker.enqueue(relation(2, 1, 2)), 'partial native-move failure');
  await stacker.idle();
  assert.equal(model.calls.filter(call => call.method === 'move' && call.args[0] === 3).length, 2);
  assert.equal(errors.length, 1, 'an incomplete branch must be surfaced to the policy-owning layer');
  assert.notEqual(model.tab(3).groupId, model.tab(1).groupId, 'the evaluator must expose the actual partial result');
  assert.equal(sameGroup(model, 1, 4, 5), 8, 'confirmed descendant moves are retained');
  assert.equal(stacker.diagnostics().pending, 0);
  await settle(stacker, [relation(6, 1, 2)]);
  assert.equal(sameGroup(model, 1, 6), 8);
});

test('fallback keeps its expanded plan when one move implicitly relocates an ancestor', async () => {
  let failChildOnce = true;
  const { model, stacker, errors } = fixture([
    ...Array.from({ length: 4 }, (_, index) => tab(index + 1, {
      windowId: 2, incognito: true, ...(index === 0 ? { groupId: 8 } : {}),
    })),
    tab(5),
  ], {}, {
    currentWindowId: 1,
    beforeCall({ method, args }, state) {
      if (method !== 'move') return;
      // Model the consequential effect of Firefox's split-view atomic unit:
      // moving member 4 also relocates ancestor 2. This tests plan retention,
      // not split-view creation, positioning, or browser implementation fidelity.
      if (args[0] === 4) state.patch(2, { groupId: 8 });
      if (args[0] === 3 && failChildOnce) {
        failChildOnce = false;
        throw new Error('Transient failure after coupled move');
      }
    },
  });
  await settle(stacker, [relation(3, 2, 2), relation(4, 2, 2)]);
  await settle(stacker, [relation(2, 1, 2)]);
  assert.equal(sameGroup(model, 1, 2, 3, 4), 8);
  assert.deepEqual(errors, []);
});

test('duplicate creation signals do not undo a later manual ungroup', async () => {
  const { model, stacker } = fixture([tab(1), tab(2)]);
  await settle(stacker, [relation(2, 1), relation(2, 1)]);
  sameGroup(model, 1, 2);
  model.patch(2, { groupId: -1 });
  const count = mutations(model).length;
  await settle(stacker, [relation(2, 1)]);
  assert.equal(model.tab(2).groupId, -1);
  assert.equal(mutations(model).length, count);
});

test('simultaneous siblings share a group despite asynchronous opener reads', async () => {
  const { model, stacker } = fixture(Array.from({ length: 18 }, (_, index) => tab(index + 1)));
  const held = model.holdNext('get', ([id]) => id === 1);
  const pending = Array.from({ length: 17 }, (_, index) => stacker.enqueue(relation(index + 2, 1)));
  await beforeDeadline(held.entered, 'opener read');
  held.release();
  await Promise.all(pending);
  await stacker.idle();
  sameGroup(model, ...Array.from({ length: 18 }, (_, index) => index + 1));
  assert.equal(model.groupIds().length, 1);
});

test('overlapping parent and descendant events preserve the complete chain', async () => {
  const { model, stacker } = fixture(Array.from({ length: 14 }, (_, index) => tab(index + 1)));
  await settle(stacker, Array.from({ length: 13 }, (_, index) => relation(index + 2, index + 1)));
  sameGroup(model, ...Array.from({ length: 14 }, (_, index) => index + 1));
});

test('a late parent relation carries already accepted descendants into the final group', async () => {
  const { model, stacker } = fixture([tab(1), tab(2), tab(3), tab(4)]);
  await settle(stacker, [relation(3, 2), relation(4, 3)]);
  sameGroup(model, 2, 3, 4);
  await settle(stacker, [relation(2, 1)]);
  sameGroup(model, 1, 2, 3, 4);
  assert.equal(model.groupIds().length, 1);
});

test('grouping a source own child cannot accept its skipped incoming relationship', async () => {
  const { model, stacker } = fixture([tab(1, { pinned: true }), tab(2), tab(3), tab(4)]);
  // Y=1 is pinned. Both events are admitted before processing: A=2 grouping
  // B=3 must not turn the pending, ineligible Y→A relationship into a live edge.
  await settle(stacker, [relation(3, 2), relation(2, 1)]);
  const original = sameGroup(model, 2, 3);
  assert.equal(model.tab(1).groupId, -1);
  model.patch(1, { pinned: false, groupId: original });
  await settle(stacker, [relation(1, 4)]);
  sameGroup(model, 1, 4);
  assert.notEqual(model.tab(1).groupId, original);
  assert.equal(sameGroup(model, 2, 3), original, 'manual co-membership does not accept the skipped Y→A edge');
});

test('a source observed outside its assigned group disowns the old incoming edge', async () => {
  const { model, stacker } = fixture([tab(1), tab(2), tab(3), tab(4)]);
  await settle(stacker, [relation(2, 1)]);
  sameGroup(model, 1, 2);
  model.patch(2, { groupId: -1 });
  await settle(stacker, [relation(3, 2)]);
  const independent = sameGroup(model, 2, 3);
  assert.notEqual(model.tab(1).groupId, independent);
  // Y manually joins A's new group; that does not reconnect the old Y→A edge
  // which the extension already observed A leave before creating its own group.
  model.patch(1, { groupId: independent });
  await settle(stacker, [relation(1, 4)]);
  sameGroup(model, 1, 4);
  assert.notEqual(model.tab(1).groupId, independent);
  assert.equal(sameGroup(model, 2, 3), independent);
});

test('a descendant manually reassigned before a late parent is not pulled back', async () => {
  const { model, stacker } = fixture([tab(1), tab(2), tab(3), tab(4, { groupId: 9 })]);
  await settle(stacker, [relation(3, 2)]);
  model.patch(3, { groupId: 9 });
  await settle(stacker, [relation(2, 1)]);
  sameGroup(model, 1, 2);
  assert.equal(sameGroup(model, 3, 4), 9);
});

test('a descendant moved to another window is not pulled back by a late parent', async () => {
  const { model, stacker } = fixture([tab(1), tab(2), tab(3), tab(4, { windowId: 2 })]);
  await settle(stacker, [relation(3, 2)]);
  model.patch(3, { windowId: 2, groupId: -1 });
  await settle(stacker, [relation(2, 1)]);
  sameGroup(model, 1, 2);
  assert.equal(model.tab(3).windowId, 2);
  assert.equal(model.tab(3).groupId, -1);
});

test('closing either endpoint during its read does not block later work', async () => {
  for (const closedId of [1, 2]) {
    const { model, stacker } = fixture([tab(1), tab(2), tab(3), tab(4)]);
    const held = model.holdNext('get', ([id]) => id === closedId);
    const pending = stacker.enqueue(relation(2, 1));
    await beforeDeadline(held.entered, 'endpoint read');
    model.close(closedId);
    stacker.forget(closedId);
    held.release();
    await beforeDeadline(pending, 'closed endpoint completion');
    await settle(stacker, [relation(4, 3)]);
    sameGroup(model, 3, 4);
  }
});

test('a single tab closing in a pending batch does not abandon surviving siblings', async () => {
  const { model, stacker } = fixture([tab(1), tab(2), tab(3), tab(4)]);
  const held = model.holdNext('group', ([options]) => [options.tabIds].flat().includes(3));
  const pending = [2, 3, 4].map(id => stacker.enqueue(relation(id, 1)));
  await beforeDeadline(held.entered, 'batch containing closing member');
  model.close(3);
  stacker.forget(3);
  held.release();
  await beforeDeadline(Promise.all(pending), 'batch recovery');
  await stacker.idle();
  sameGroup(model, 1, 2, 4);
});

test('a transient mutation rejection is recovered with fresh browser state', async () => {
  const { model, stacker } = fixture([tab(1), tab(2)]);
  model.failNext('group', new Error('No group with id: 999'));
  await settle(stacker, [relation(2, 1)]);
  sameGroup(model, 1, 2);
  assert.ok(mutations(model).length <= 3, 'recovery must have a bounded number of attempts');
});

test('persistent mutation rejection is bounded, reported, and does not strand the queue', async () => {
  const { model, stacker, errors } = fixture([tab(1), tab(2), tab(3), tab(4)]);
  for (let count = 0; count < 20; count++) model.failNext('group', new Error('Persistent native failure'));
  await beforeDeadline(stacker.enqueue(relation(2, 1)), 'bounded rejection');
  await stacker.idle();
  const attempts = model.calls.filter(call => call.method === 'group').length;
  assert.ok(attempts > 0 && attempts <= 3, `unexpected attempt count: ${attempts}`);
  assert.ok(errors.length > 0, 'failure must reach the policy-owning layer');
  assert.equal(stacker.diagnostics().pending, 0);
  // A rejected queue tail must still allow a distinct relationship to finish.
  await beforeDeadline(stacker.enqueue(relation(4, 3)), 'subsequent rejected operation');
  await stacker.idle();
  assert.equal(stacker.diagnostics().pending, 0);
});

test('unexpected read rejection is reported without an unhandled rejection', async () => {
  const { model, stacker, errors } = fixture([tab(1), tab(2)]);
  for (let count = 0; count < 20; count++) model.failNext('get', new Error('Reader unavailable'));
  await beforeDeadline(stacker.enqueue(relation(2, 1)), 'read rejection');
  await stacker.idle();
  assert.deepEqual(mutations(model), []);
  assert.ok(errors.length > 0);
  assert.equal(stacker.diagnostics().pending, 0);
});

test('structured missing-tab errors are recognized across API realms', async () => {
  const { model, stacker, errors } = fixture([tab(1), tab(2)]);
  model.failNext('get', { message: 'Invalid tab ID: 1' });
  await settle(stacker, [relation(2, 1)]);
  assert.deepEqual(mutations(model), []);
  assert.deepEqual(errors, []);
});

test('structured privacy errors still select the safe native-move fallback', async () => {
  const { model, stacker, errors } = fixture([tab(1, { groupId: 8 }), tab(2)]);
  model.failNext('group', { message: 'Cannot move non-private tabs to private window' });
  await settle(stacker, [relation(2, 1)]);
  assert.equal(sameGroup(model, 1, 2), 8);
  assert.ok(model.calls.some(call => call.method === 'move'));
  assert.deepEqual(errors, []);
});

test('a stalled window does not block an independent window', async () => {
  const { model, stacker } = fixture([tab(1), tab(2), tab(3, { windowId: 2 }), tab(4, { windowId: 2 })]);
  const held = model.holdNext('get', ([id]) => id === 1);
  const first = stacker.enqueue(relation(2, 1));
  await beforeDeadline(held.entered, 'first window read');
  try {
    await beforeDeadline(stacker.enqueue(relation(4, 3, 2)), 'independent window');
    sameGroup(model, 3, 4);
    assert.equal(model.tab(2).groupId, -1);
  } finally {
    held.release();
  }
  await first;
  await stacker.idle();
  sameGroup(model, 1, 2);
});

test('forget removes retained relationships and settled window queues', async () => {
  const { stacker } = fixture([tab(1), tab(2), tab(3)]);
  await settle(stacker, [relation(2, 1), relation(3, 2)]);
  for (const id of [1, 2, 3]) stacker.forget(id);
  await stacker.idle();
  assert.deepEqual(stacker.diagnostics(), { relations: 0, windows: 0, pending: 0 });
});

test('the unqueued opener-snapshot baseline has a sibling race', async () => {
  // Counterexample to the reviewed Lineage/Tabius mechanism: both handlers may
  // finish their opener read before either submits a group creation. This is a
  // legal API schedule, not an elapsed-time benchmark or a copied implementation.
  const model = createModel([tab(1), tab(2), tab(3)]);
  const [firstRead, secondRead] = await Promise.all([model.api.tabs.get(1), model.api.tabs.get(1)]);
  assert.equal(firstRead.groupId, -1);
  assert.equal(secondRead.groupId, -1);
  await model.api.tabs.group({ tabIds: [firstRead.id, 2], createProperties: { windowId: 1 } });
  await model.api.tabs.group({ tabIds: [secondRead.id, 3], createProperties: { windowId: 1 } });
  assert.notEqual(model.tab(2).groupId, model.tab(3).groupId);
});

test('bounded sibling batching removes redundant API work under matched admission', async () => {
  const count = 64;
  const results = [];
  for (const batchSize of [1, 32]) {
    const { model, stacker } = fixture(Array.from({ length: count + 1 }, (_, index) => tab(index + 1)), { batchSize });
    await settle(stacker, Array.from({ length: count }, (_, index) => relation(index + 2, 1)));
    sameGroup(model, ...Array.from({ length: count + 1 }, (_, index) => index + 1));
    results.push({
      reads: model.calls.filter(call => call.method === 'get').length,
      writes: mutations(model).length,
    });
  }
  // This checks a deterministic operation-count argument for a declared burst
  // scenario. It is deliberately not an elapsed-time or memory benchmark.
  assert.deepEqual(results[0], { reads: count * 2, writes: count });
  assert.deepEqual(results[1], { reads: count + 2, writes: 2 });
});

function makeForest(seed, size = 35) {
  let state = seed;
  const random = max => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % max;
  };
  const tabs = [];
  const edges = [];
  for (let id = 1; id <= size; id++) {
    const windowId = id % 2 + 1;
    tabs.push(tab(id, { windowId }));
    const predecessors = tabs.filter(candidate => candidate.windowId === windowId && candidate.id < id);
    if (predecessors.length && random(4) !== 0) edges.push(relation(id, predecessors[random(predecessors.length)].id, windowId));
  }
  for (let index = edges.length - 1; index > 0; index--) {
    const other = random(index + 1);
    [edges[index], edges[other]] = [edges[other], edges[index]];
  }
  return { tabs, edges };
}

function componentOracle(tabs, edges) {
  const representatives = new Map(tabs.map(item => [item.id, item.id]));
  const root = id => {
    while (representatives.get(id) !== id) id = representatives.get(id);
    return id;
  };
  for (const { tabId, sourceTabId } of edges) representatives.set(root(tabId), root(sourceTabId));
  const components = new Map();
  for (const { id } of tabs) {
    const representative = root(id);
    if (!components.has(representative)) components.set(representative, []);
    components.get(representative).push(id);
  }
  return [...components.values()].map(component => component.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}

function actualComponents(model) {
  const groups = new Map();
  for (const item of model.tabs()) {
    const key = item.groupId === -1 ? `tab:${item.id}` : `group:${item.groupId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.id);
  }
  return [...groups.values()].map(component => component.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}

for (const seed of [1, 17, 771, 0x12345678]) {
  test(`batching and FIFO satisfy the independent forest oracle (seed ${seed})`, async () => {
    const { tabs, edges } = makeForest(seed);
    const expected = componentOracle(tabs, edges);
    const results = [];
    for (const batchSize of [1, 32]) {
      const { model, stacker, errors } = fixture(tabs, { batchSize });
      await settle(stacker, edges);
      const actual = actualComponents(model);
      assert.deepEqual(actual, expected, `batch size ${batchSize}`);
      assert.deepEqual(errors, []);
      for (const original of tabs) assert.equal(model.tab(original.id).windowId, original.windowId);
      results.push(actual);
    }
    assert.deepEqual(results[0], results[1]);
  });
}
