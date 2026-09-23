import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createStacker } from './dependency-stacker.js';
import { createModel } from '../tests/model.js';

// Run the unchanged production model suite against this candidate. Absolute
// imports allow loading the copied test text without modifying existing files.
const suite = (await readFile(new URL('../tests/stacker.test.js', import.meta.url), 'utf8'))
  .replace('../extension/stacker.js', new URL('./dependency-stacker.js', import.meta.url).href)
  .replace('./model.js', new URL('../tests/model.js', import.meta.url).href);
await import(`data:text/javascript;base64,${Buffer.from(suite).toString('base64')}`);

const relation = (tabId, sourceTabId) => ({ tabId, sourceTabId, windowId: 1 });
const tabs = count => Array.from({ length: count }, (_, index) => ({ id: index + 1, windowId: 1 }));
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Dependency scheduler stalled')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test('dependency candidate lets disjoint roots progress in the same window', async () => {
  const model = createModel(tabs(4));
  const stacker = createStacker(model.api);
  const hold = model.holdNext('get', ([id]) => id === 1);
  const first = stacker.enqueue(relation(2, 1));
  await bounded(hold.entered);
  try {
    await bounded(stacker.enqueue(relation(4, 3)));
    assert.notEqual(model.tab(3).groupId, -1);
    assert.equal(model.tab(3).groupId, model.tab(4).groupId);
    assert.equal(model.tab(1).groupId, -1);
  } finally { hold.release(); }
  await first;
  await stacker.idle();
});

test('merging components waits for both earlier tails', async () => {
  const model = createModel(tabs(4));
  const stacker = createStacker(model.api);
  const hold = model.holdNext('get', ([id]) => id === 1);
  const first = stacker.enqueue(relation(2, 1));
  const second = stacker.enqueue(relation(4, 3));
  await bounded(hold.entered);
  await second;
  const bridge = stacker.enqueue(relation(3, 2));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.tab(2).groupId, -1, 'bridge cannot overtake its unresolved source component');
  hold.release();
  await Promise.all([first, bridge]);
  await stacker.idle();
  assert.notEqual(model.tab(1).groupId, -1);
  for (const tab of model.tabs()) assert.equal(tab.groupId, model.tab(1).groupId);
});

test('private fallback excludes ordinary mutations and their eligibility reads', async () => {
  const model = createModel([
    { id: 1, windowId: 1, incognito: true, groupId: 8 },
    ...[2, 3, 4].map(id => ({ id, windowId: 1, incognito: true })),
    { id: 5, windowId: 2 },
  ], { currentWindowId: 2 });
  const stacker = createStacker(model.api);
  const hold = model.holdNext('move', ([id]) => id === 2);
  const first = stacker.enqueue(relation(2, 1));
  await bounded(hold.entered);
  const second = stacker.enqueue(relation(4, 3));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.calls.filter(call => call.method === 'get' && call.args[0] === 3).length, 0);
  hold.release();
  await Promise.all([first, second]);
  await stacker.idle();
  assert.equal(model.tab(2).groupId, 8);
  assert.notEqual(model.tab(3).groupId, -1);
  assert.equal(model.tab(3).groupId, model.tab(4).groupId);
});

test('split-view mutation waits for active readers and rereads under its exclusive permit', async () => {
  const model = createModel([
    { id: 1, windowId: 1, splitViewId: 10 },
    ...[2, 3, 4].map(id => ({ id, windowId: 1 })),
  ]);
  const stacker = createStacker(model.api);
  const hold = model.holdNext('get', ([id]) => id === 3);
  const ordinary = stacker.enqueue(relation(4, 3));
  await bounded(hold.entered);
  const splitWork = stacker.enqueue(relation(2, 1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.calls.filter(call => call.method === 'group').length, 0);
  hold.release();
  await Promise.all([ordinary, splitWork]);
  await stacker.idle();
  const groups = model.calls.filter(call => call.method === 'group');
  assert.ok(groups[0].args[0].tabIds.includes(4));
  assert.ok(groups[1].args[0].tabIds.includes(2));
  assert.equal(model.calls.filter(call => call.method === 'get' && call.args[0] === 1).length, 2);
});

test('multiple simultaneous privacy escalations do not deadlock the window gate', async () => {
  const model = createModel([
    ...Array.from({ length: 12 }, (_, index) => ({
      id: index + 1, windowId: 1, incognito: true,
      groupId: index % 2 === 0 ? index + 100 : -1,
    })),
    { id: 20, windowId: 2 },
  ], { currentWindowId: 2 });
  const errors = [];
  const stacker = createStacker(model.api, { onError: error => errors.push(error) });
  await bounded(Promise.all(Array.from({ length: 6 }, (_, index) => stacker.enqueue(relation(index * 2 + 2, index * 2 + 1)))));
  await stacker.idle();
  for (let id = 1; id <= 12; id += 2) assert.equal(model.tab(id + 1).groupId, model.tab(id).groupId);
  assert.deepEqual(errors, []);
});

test('disjoint lineage components may share native groups without racing membership', async () => {
  const model = createModel([
    { id: 1, windowId: 1, groupId: 8 }, { id: 2, windowId: 1, groupId: 9 },
    { id: 3, windowId: 1, groupId: 9 }, { id: 4, windowId: 1, groupId: 8 },
  ]);
  const stacker = createStacker(model.api);
  await Promise.all([stacker.enqueue(relation(2, 1)), stacker.enqueue(relation(4, 3))]);
  await stacker.idle();
  assert.equal(model.tab(2).groupId, 8);
  assert.equal(model.tab(4).groupId, 9);
});

test('siblings accumulated behind an active component still coalesce across event turns', async () => {
  const model = createModel(tabs(35));
  const stacker = createStacker(model.api);
  const hold = model.holdNext('get', ([id]) => id === 1);
  const jobs = [stacker.enqueue(relation(2, 1))];
  await bounded(hold.entered);
  for (let id = 3; id <= 35; id++) {
    jobs.push(stacker.enqueue(relation(id, 1)));
    await new Promise(resolve => setImmediate(resolve));
  }
  hold.release();
  await Promise.all(jobs);
  await stacker.idle();
  assert.equal(model.calls.filter(call => call.method === 'group').length, 3);
  assert.equal(model.calls.filter(call => call.method === 'get').length, 37);
  for (const item of model.tabs()) assert.equal(item.groupId, model.tab(1).groupId);
});

test('component identity follows moved ancestry and waits for a descendant new child', async () => {
  const model = createModel([
    { id: 1, windowId: 2 }, { id: 2, windowId: 1 }, { id: 3, windowId: 1 },
    { id: 4, windowId: 2 }, { id: 5, windowId: 1 }, { id: 6, windowId: 1 },
  ]);
  const stacker = createStacker(model.api);
  await stacker.enqueue(relation(3, 2));
  const original = model.tab(2).groupId;
  model.patch(6, { groupId: original }); // an unrelated member retains the old group
  for (const id of [2, 3, 6]) model.patch(id, { windowId: 2 });
  const hold = model.holdNext('group', ([options]) => options.groupId === original);
  const descendant = stacker.enqueue({ tabId: 4, sourceTabId: 3, windowId: 2 });
  await bounded(hold.entered);
  const ancestor = stacker.enqueue({ tabId: 2, sourceTabId: 1, windowId: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.tab(1).groupId, -1, 'ancestor must not overtake the moved component');
  hold.release();
  await Promise.all([ancestor, descendant]);
  await stacker.idle();
  const final = model.tab(1).groupId;
  assert.notEqual(final, -1);
  for (const id of [2, 3, 4]) assert.equal(model.tab(id).groupId, final);
  assert.equal(model.tab(6).groupId, original, 'unrelated old-group member stays behind');
});
