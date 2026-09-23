import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PAIRS } from '../extension/name-catalog.js';

// Keep preprocessing, lexical policy, RNG and fallback identical. Only replace
// the final edge-selection mechanism. These are never packaged for users.
export async function namingCandidates() {
  const source = await readFile(new URL('../extension/name-generator.js', import.meta.url), 'utf8');
  const marker = '  let bestMaximum = Infinity;';
  const start = source.indexOf(marker);
  const fallbackStart = source.indexOf('  if (eligible === 0) {', start);
  const randomStart = source.indexOf('  const draw = random();', fallbackStart);
  assert(start > 0 && fallbackStart > start && randomStart > fallbackStart);
  const prefix = source.slice(0, start);
  const fallback = source.slice(fallbackStart, randomStart);
  const rng = `
function rank(random, count) {
  const draw = random();
  if (typeof draw !== 'bigint' || draw < 0n || draw >= RANDOM_RANGE) throw new RangeError('random must return an unsigned 64-bit bigint');
  return Number(draw * BigInt(count) >> 64n);
}
`;
  const returnEdge = `return { name: WORDS[PAIRS[picked]] + '-' + WORDS[ADJECTIVE_COUNT + PAIRS[picked + 1]], kind: 'pair', eligible };`;
  const filterArray = prefix + `
  let bestMaximum = Infinity, bestSum = Infinity, firstBestEdge = 0;
  const candidates = [];
  for (let edge = 0; edge < PAIRS.length; edge += 2) {
    const a = PAIRS[edge], n = PAIRS[edge + 1], index = a * NOUN_COUNT + n;
    if (blocked[index >>> 3] & (1 << (index & 7))) continue;
    const maximum = Math.max(adjectiveUses[a], nounUses[n]);
    const sum = adjectiveUses[a] + nounUses[n];
    if (maximum < bestMaximum || maximum === bestMaximum && sum < bestSum) {
      bestMaximum = maximum; bestSum = sum; firstBestEdge = edge; candidates.length = 0;
    }
    if (maximum === bestMaximum && sum === bestSum) candidates.push(edge);
  }
  const eligible = candidates.length;
` + fallback + `  const picked = candidates[rank(random, eligible)];
  ${returnEdge}
}
` + rng;
  const reservoir = prefix + `
  let bestMaximum = Infinity, bestSum = Infinity, eligible = 0, picked = -1, firstBestEdge = 0;
  for (let edge = 0; edge < PAIRS.length; edge += 2) {
    const a = PAIRS[edge], n = PAIRS[edge + 1], index = a * NOUN_COUNT + n;
    if (blocked[index >>> 3] & (1 << (index & 7))) continue;
    const maximum = Math.max(adjectiveUses[a], nounUses[n]);
    const sum = adjectiveUses[a] + nounUses[n];
    if (maximum < bestMaximum || maximum === bestMaximum && sum < bestSum) {
      bestMaximum = maximum; bestSum = sum; eligible = 1; picked = edge; firstBestEdge = edge;
    } else if (maximum === bestMaximum && sum === bestSum) {
      eligible++;
      if (rank(random, eligible) === 0) picked = edge;
    }
  }
` + fallback + `  ${returnEdge}
}
` + rng;
  const rejection = source.slice(0, randomStart) + `
  // A fixed cap preserves bounded completion even with one eligible edge.
  for (let attempt = 0; attempt < 8; attempt++) {
    const picked = rank(random, PAIRS.length / 2) * 2;
    const a = PAIRS[picked], n = PAIRS[picked + 1], index = a * NOUN_COUNT + n;
    if (!(blocked[index >>> 3] & (1 << (index & 7))) &&
      Math.max(adjectiveUses[a], nounUses[n]) === bestMaximum &&
      adjectiveUses[a] + nounUses[n] === bestSum) { ${returnEdge} }
  }
` + source.slice(randomStart) + rng;
  const typedArray = filterArray.replace('const candidates = [];', 'const candidates = new Uint16Array(PAIRS.length / 2); let size = 0;')
    .replace('candidates.length = 0;', 'size = 0;').replace('candidates.push(edge)', 'candidates[size++] = edge')
    .replace('const eligible = candidates.length;', 'const eligible = size;');
  assert(PAIRS.length - 2 <= 65_535, 'Contender edge offsets must fit Uint16');
  const buffered = reservoir.replace('random = random64', 'random = bufferedRandom64') + `
const buffer = new Uint32Array(64);
let cursor = buffer.length;
function bufferedRandom64() {
  if (cursor === buffer.length) { crypto.getRandomValues(buffer); cursor = 0; }
  return (BigInt(buffer[cursor++]) << 32n) | BigInt(buffer[cursor++]);
}
`;
  return { 'two-pass': source, array: filterArray, 'typed-array': typedArray, reservoir, 'reservoir-buffered': buffered, 'rejection-8': rejection };
}
