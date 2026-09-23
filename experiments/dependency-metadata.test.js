import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createStacker } from './dependency-stacker.js';
import { createModel } from '../tests/model.js';

// Keep the production metadata oracle unchanged for this scheduler contender.
const suite = (await readFile(new URL('../tests/metadata.test.js', import.meta.url), 'utf8'))
  .replace('../extension/stacker.js', new URL('./dependency-stacker.js', import.meta.url).href)
  .replace('./model.js', new URL('../tests/model.js', import.meta.url).href);
await import(`data:text/javascript;base64,${Buffer.from(suite).toString('base64')}`);

test('dependency metadata proof excludes other components until the native mutation completes', { timeout: 3000 }, async () => {
  const model = createModel([1, 2, 3, 4, 5].map(id => ({ id, windowId: 1 })));
  const errors = [];
  const stacker = createStacker(model.api, { onError: error => errors.push(error) });
  await stacker.enqueue({ tabId: 3, sourceTabId: 2, windowId: 1 });
  const original = model.tab(2).groupId;
  model.setGroupMetadata(original, { title: 'Retained branch', color: 'red' });
  const held = model.holdNext('query');
  const late = stacker.enqueue({ tabId: 2, sourceTabId: 1, windowId: 1 });
  await held.entered;
  const before = model.calls.length;
  const unrelated = stacker.enqueue({ tabId: 5, sourceTabId: 4, windowId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.calls.length, before, 'other component eligibility reads wait for the proof and commit');
  held.release();
  await Promise.all([late, unrelated]);
  await stacker.idle();
  assert.equal(model.tab(1).groupId, original);
  assert.equal(model.group(original).title, 'Retained branch');
  assert.equal(model.tab(4).groupId, model.tab(5).groupId);
  assert.notEqual(model.tab(4).groupId, original);
  assert.deepEqual(errors, []);
});
