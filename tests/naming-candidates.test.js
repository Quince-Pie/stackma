import test from 'node:test';
import assert from 'node:assert/strict';
import { namingCandidates } from '../experiments/naming-candidates.js';
import { PAIRS, WORDS, ADJECTIVE_COUNT } from '../extension/name-catalog.js';

const catalog = new URL('../extension/name-catalog.js', import.meta.url).href;
const modules = Object.fromEntries(await Promise.all(Object.entries(await namingCandidates()).map(async ([name, source]) => {
  const module = await import(`data:text/javascript;base64,${Buffer.from(source.replace('"./name-catalog.js"', JSON.stringify(catalog))).toString('base64')}`);
  return [name, module];
})));
const all = Array.from({ length: PAIRS.length / 2 }, (_, i) => `${WORDS[PAIRS[2 * i]]}-${WORDS[ADJECTIVE_COUNT + PAIRS[2 * i + 1]]}`);
const range = 1n << 64n;

test('matched naming challengers use the same eligible edge set and exact fallback', () => {
  const scenarios = [[], ['sleepy-otter'], all.slice(0, 32), all.slice(0, 256), all, [...all, 'stack-1', 'stack-3']];
  for (const titles of scenarios) {
    const reference = modules['two-pass'].chooseName(titles, () => 0n);
    const eligible = new Set();
    for (let rank = 0; rank < reference.eligible; rank++) {
      eligible.add(modules['two-pass'].chooseName(titles, () => (BigInt(rank) * range + BigInt(reference.eligible) - 1n) / BigInt(reference.eligible)).name);
    }
    for (const [variant, module] of Object.entries(modules)) {
      for (const draw of [0n, range / 3n, range - 1n]) {
        const result = module.chooseName(titles, () => draw);
        assert.equal(result.eligible, reference.eligible, variant);
        if (eligible.size) assert(eligible.has(result.name), variant);
        else assert.deepEqual(result, reference, variant);
      }
    }
  }
});

test('array control preserves edge ranks; reservoir covers first/last edge without a candidate array', () => {
  for (let i = 0; i < all.length; i++) {
    const draw = (BigInt(i) * range + BigInt(all.length) - 1n) / BigInt(all.length);
    assert.equal(modules.array.chooseName([], () => draw).name, all[i]);
  }
  assert.equal(modules.reservoir.chooseName([], () => 0n).name, all.at(-1));
  assert.equal(modules.reservoir.chooseName([], () => range - 1n).name, all[0]);
});
