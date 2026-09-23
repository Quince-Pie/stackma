import assert from 'node:assert/strict';
import test from 'node:test';
import { createStacker } from '../extension/stacker.js';
import { createModel } from './model.js';

const relation = (tabId, sourceTabId, windowId = 1) => ({ tabId, sourceTabId, windowId });
const metadata = { title: 'Research — 日本語', color: 'purple', collapsed: true, saveOnWindowClose: false };
const tab = (id, properties = {}) => ({ id, windowId: 1, ...properties });

function fixture(tabs, options) {
  const model = createModel(tabs, options);
  const errors = [];
  const stacker = createStacker(model.api, { onError: error => errors.push(error) });
  return { model, stacker, errors };
}

async function accept(stacker, ...relations) {
  await Promise.all(relations.map(item => stacker.enqueue(item)));
  await stacker.idle();
}

function assertMetadata(model, id, expected = metadata) {
  const group = model.group(id);
  assert.ok(group, 'the existing native group survives');
  for (const [key, value] of Object.entries(expected)) assert.equal(group[key], value, key);
}

for (const order of [[1, 2, 3, 4, 5], [2, 3, 1, 4, 5], [1, 4, 2, 3, 5], [4, 2, 3, 5, 1]]) {
  test(`late parent preserves exclusive branch identity and metadata, order ${order}`, async () => {
    const { model, stacker, errors } = fixture(order.map(id => tab(id)));
    await accept(stacker, relation(3, 2));
    const original = model.tab(2).groupId;
    model.setGroupMetadata(original, metadata);
    await accept(stacker, relation(2, 1));
    for (const id of [1, 2, 3]) assert.equal(model.tab(id).groupId, original);
    assertMetadata(model, original);
    assert.deepEqual(model.tabs().filter(tab => [4, 5].includes(tab.id)).map(tab => tab.id), [4, 5]);
    assert.deepEqual(errors, []);
    assert.ok(model.calls.filter(call => call.method === 'query').every(call =>
      Number.isInteger(call.args[0].index) && call.args[0].windowId === 1), 'membership probes use single indices');
  });
}

test('existing opener group and its metadata take precedence over a child branch', async () => {
  const { model, stacker } = fixture([tab(1, { groupId: 9 }), tab(4, { groupId: 9 }), tab(2), tab(3)]);
  const parentMetadata = { title: 'Parent', color: 'grey', collapsed: false, saveOnWindowClose: true };
  model.setGroupMetadata(9, parentMetadata);
  await accept(stacker, relation(3, 2));
  const childGroup = model.tab(2).groupId;
  model.setGroupMetadata(childGroup, metadata);
  await accept(stacker, relation(2, 1));
  for (const id of [1, 2, 3, 4]) assert.equal(model.tab(id).groupId, 9);
  assertMetadata(model, 9, parentMetadata);
  assert.equal(model.group(childGroup), undefined);
});

test('metadata edits made after membership reads survive the eventual native join', { timeout: 3000 }, async () => {
  const { model, stacker } = fixture([tab(1), tab(2), tab(3), tab(4)]);
  await accept(stacker, relation(3, 2));
  const original = model.tab(2).groupId;
  const held = model.holdNext('group');
  const pending = stacker.enqueue(relation(2, 1));
  await held.entered;
  model.setGroupMetadata(original, metadata);
  held.release();
  await pending;
  await accept(stacker, relation(4, 1));
  assert.equal(model.tab(4).groupId, original);
  assertMetadata(model, original);
});

for (const order of [[1, 4, 2, 3], [1, 2, 3, 4]]) {
  test(`unrelated child-group member remains in its original group, order ${order}`, async () => {
    const { model, stacker } = fixture(order.map(id => tab(id)));
    await accept(stacker, relation(3, 2));
    const original = model.tab(2).groupId;
    model.patch(4, { groupId: original });
    model.setGroupMetadata(original, metadata);
    await accept(stacker, relation(2, 1));
    assert.notEqual(model.tab(1).groupId, original);
    assert.equal(model.tab(2).groupId, model.tab(1).groupId);
    assert.equal(model.tab(3).groupId, model.tab(1).groupId);
    assert.equal(model.tab(4).groupId, original);
    assertMetadata(model, original);
  });
}

test('first exclusive child group in event order wins a merge of two branches', async () => {
  const { model, stacker } = fixture([1, 2, 3, 4, 5].map(id => tab(id)));
  await accept(stacker, relation(3, 2), relation(5, 4));
  const first = model.tab(2).groupId;
  const second = model.tab(4).groupId;
  model.setGroupMetadata(first, metadata);
  model.setGroupMetadata(second, { title: 'Other', color: 'red' });
  await accept(stacker, relation(2, 1), relation(4, 1));
  for (const id of [1, 2, 3, 4, 5]) assert.equal(model.tab(id).groupId, first);
  assertMetadata(model, first);
  assert.equal(model.group(second), undefined);
});

test('private-window mismatch fallback retains exclusive branch metadata', async () => {
  const { model, stacker, errors } = fixture([
    tab(9), ...[1, 2, 3].map(id => tab(id, { windowId: 2, incognito: true })),
  ], { currentWindowId: 1 });
  await accept(stacker, relation(3, 2, 2));
  const original = model.tab(2).groupId;
  model.setGroupMetadata(original, metadata);
  await accept(stacker, relation(2, 1, 2));
  for (const id of [1, 2, 3]) {
    assert.equal(model.tab(id).groupId, original);
    assert.equal(model.tab(id).windowId, 2);
    assert.equal(model.tab(id).incognito, true);
  }
  assertMetadata(model, original);
  assert.deepEqual(errors, []);
});

test('one failed membership probe is retried without losing metadata', async () => {
  const { model, stacker, errors } = fixture([1, 2, 3].map(id => tab(id)));
  await accept(stacker, relation(3, 2));
  const original = model.tab(2).groupId;
  model.setGroupMetadata(original, metadata);
  model.failNext('query');
  await accept(stacker, relation(2, 1));
  assert.equal(model.tab(1).groupId, original);
  assertMetadata(model, original);
  assert.deepEqual(errors, []);
});

test('persistent failed membership probes report failure and release the lane', async () => {
  let failProbes = false;
  const { model, stacker, errors } = fixture([1, 2, 3, 4, 5].map(id => tab(id)), {
    beforeCall({ method }) {
      if (failProbes && method === 'query') throw new Error('Persistent query failure');
    },
  });
  await accept(stacker, relation(3, 2));
  const original = model.tab(2).groupId;
  model.setGroupMetadata(original, metadata);
  failProbes = true;
  await accept(stacker, relation(2, 1));
  assert.equal(model.tab(1).groupId, -1);
  assertMetadata(model, original);
  assert.equal(errors.length, 1);
  failProbes = false;
  await accept(stacker, relation(5, 4));
  assert.equal(model.tab(5).groupId, model.tab(4).groupId);
  assert.notEqual(model.tab(4).groupId, -1);
  assert.equal(stacker.diagnostics().windows, 0);
});

test('opener closure during exclusivity probing does not replace the child group', { timeout: 3000 }, async () => {
  const { model, stacker, errors } = fixture([1, 2, 3].map(id => tab(id)));
  await accept(stacker, relation(3, 2));
  const original = model.tab(2).groupId;
  model.setGroupMetadata(original, metadata);
  const held = model.holdNext('query');
  const pending = stacker.enqueue(relation(2, 1));
  await held.entered;
  model.close(1);
  held.release();
  await pending;
  await stacker.idle();
  assert.equal(model.tab(2).groupId, original);
  assert.equal(model.tab(3).groupId, original);
  assertMetadata(model, original);
  assert.deepEqual(errors, []);
});
