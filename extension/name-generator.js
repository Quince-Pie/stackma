import {
  ADJECTIVE_COUNT, NOUN_COUNT, MAX_WORD_LENGTH, WORDS, VARIANTS,
  NEAR_ADJECTIVES, NEAR_NOUNS, PAIRS,
} from "./name-catalog.js";

const RANDOM_RANGE = 1n << 64n;
const WORD_IDS = new Map(WORDS.map((word, index) => [word, index]));
for (const [variant, index] of VARIANTS) WORD_IDS.set(variant, index);

/**
 * Conservative matching form only; manual display titles are never rewritten.
 * NFKC folds compatibility characters. Edge separators are ignored; all runs
 * of whitespace, underscore, Unicode dash punctuation or minus become '-'.
 * @param {string} title
 * @returns {string}
 */
export function normalizeName(title) {
  return title.normalize("NFKC").toLowerCase().normalize("NFKC")
    .replace(/[\s_\p{Dash_Punctuation}\u2212]+/gu, "-").replace(/^-|-$/gu, "");
}

/** @returns {bigint} */
function random64() {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return (BigInt(words[0]) << 32n) | BigInt(words[1]);
}

/** One insertion, deletion or substitution over Unicode code points.
 * Catalog words are ASCII; the manual token is split once, outside this loop.
 * @param {readonly string[]} token
 * @param {string} word
 */
function withinOneEdit(token, word) {
  if (Math.abs(token.length - word.length) > 1) return false;
  let left = 0;
  let right = 0;
  let edits = 0;
  while (left < token.length && right < word.length) {
    if (token[left] === word[right]) {
      left++;
      right++;
      continue;
    }
    if (++edits > 1) return false;
    if (token.length >= word.length) left++;
    if (word.length >= token.length) right++;
  }
  return edits + (left < token.length || right < word.length ? 1 : 0) <= 1;
}

/**
 * Known words use all reviewed neighbors, including links crossing word roles.
 * Unknown manual words only get spelling checks: no guessed sound or meaning.
 * @param {string} token
 * @param {boolean} adjective
 * @returns {readonly number[]}
 */
function neighbors(token, adjective) {
  const known = WORD_IDS.get(token);
  if (known !== undefined) return adjective ? NEAR_ADJECTIVES[known] : NEAR_NOUNS[known];
  // Even all-surrogate code points cannot fit within one edit beyond this bound.
  if (token.length > 2 * (MAX_WORD_LENGTH + 1)) return [];
  const points = Array.from(token);
  const start = adjective ? 0 : ADJECTIVE_COUNT;
  const end = adjective ? ADJECTIVE_COUNT : WORDS.length;
  const result = [];
  for (let index = start; index < end; index++) {
    if (withinOneEdit(points, WORDS[index])) result.push(index - start);
  }
  for (const [variant, index] of VARIANTS) {
    if (index >= start && index < end && !result.includes(index - start) && withinOneEdit(points, variant)) {
      result.push(index - start);
    }
  }
  return result;
}

/**
 * Select an approved edge distinct from a finite, synchronous title snapshot.
 * No browser state is read or mutated. The caller owns reservation/serialization.
 *
 * Hard rule: exact normalized duplicates and pairs whose BOTH slots are near
 * an occupied two-token title are excluded. Self-neighbors make the latter also
 * enforce exact uniqueness without allocating a candidate string on every edge.
 *
 * Remaining edges minimize (max(component counts), sum(component counts)), in
 * that order. Counts are a reuse heuristic, not a human memorability score.
 * `eligible` is the number of edges in this best tier. Two passes count and select
 * directly from edges; uneven adjective degrees do not add a sampling bias.
 * With a uniform unsigned 64-bit input, multiply-range mapping differs from the
 * ideal probability for each edge by less than 2^-64. It is not exact uniformity.
 *
 * When all pairs are blocked, stack-N is explicitly an exact-uniqueness fallback;
 * it makes no lexical-discrimination promise. At most occupied.size + 1 suffixes
 * are examined. No random draw or retry is needed for fallback.
 *
 * Time: input normalization + bounded vocabulary matching per two-token title +
 * two scans of the approved edge list. Space: distinct normalized titles, two
 * fixed component counters and one fixed Cartesian confusion bitset; no list of
 * candidate edges. Arbitrary manual labels lack phonetic/semantic coverage unless
 * their tokens are known catalog words or variants.
 * @param {Iterable<string>} titles
 * @param {() => bigint} [random]
 * @returns {{name: string, kind: "pair" | "numbered", eligible: number}}
 */
export function chooseName(titles, random = random64) {
  const occupied = new Set();
  // Float64 avoids silently wrapping a 32-bit occurrence count.
  const adjectiveUses = new Float64Array(ADJECTIVE_COUNT);
  const nounUses = new Float64Array(NOUN_COUNT);
  const blocked = new Uint8Array(Math.ceil(ADJECTIVE_COUNT * NOUN_COUNT / 8));
  for (const title of titles) {
    const normalized = normalizeName(title);
    if (occupied.has(normalized)) continue;
    occupied.add(normalized);
    const separator = normalized.indexOf("-");
    if (separator <= 0 || separator !== normalized.lastIndexOf("-")) continue;
    const adjective = normalized.slice(0, separator);
    const noun = normalized.slice(separator + 1);
    if (!noun) continue;
    const adjectiveId = WORD_IDS.get(adjective);
    const nounId = WORD_IDS.get(noun);
    if (adjectiveId !== undefined && adjectiveId < ADJECTIVE_COUNT) adjectiveUses[adjectiveId]++;
    if (nounId !== undefined && nounId >= ADJECTIVE_COUNT) nounUses[nounId - ADJECTIVE_COUNT]++;
    const nearAdjectives = neighbors(adjective, true);
    const nearNouns = neighbors(noun, false);
    for (const a of nearAdjectives) {
      for (const n of nearNouns) {
        const index = a * NOUN_COUNT + n;
        blocked[index >>> 3] |= 1 << (index & 7);
      }
    }
  }

  let bestMaximum = Infinity;
  let bestSum = Infinity;
  let eligible = 0;
  let firstBestEdge = 0;
  for (let edge = 0; edge < PAIRS.length; edge += 2) {
    const a = PAIRS[edge];
    const n = PAIRS[edge + 1];
    const index = a * NOUN_COUNT + n;
    if (blocked[index >>> 3] & (1 << (index & 7))) continue;
    const maximum = Math.max(adjectiveUses[a], nounUses[n]);
    const sum = adjectiveUses[a] + nounUses[n];
    if (maximum < bestMaximum || maximum === bestMaximum && sum < bestSum) {
      bestMaximum = maximum;
      bestSum = sum;
      eligible = 1;
      firstBestEdge = edge;
    } else if (maximum === bestMaximum && sum === bestSum) eligible++;
  }

  if (eligible === 0) {
    const bound = BigInt(occupied.size) + 1n;
    for (let suffix = 1n; suffix <= bound; suffix++) {
      const name = `stack-${suffix}`;
      if (!occupied.has(name)) return { name, kind: "numbered", eligible: 0 };
    }
    throw new Error("Name fallback violated its cardinality bound");
  }

  // A single remaining choice needs neither entropy nor another edge scan.
  if (eligible === 1) {
    const a = PAIRS[firstBestEdge], n = PAIRS[firstBestEdge + 1];
    return { name: `${WORDS[a]}-${WORDS[ADJECTIVE_COUNT + n]}`, kind: "pair", eligible };
  }

  const draw = random();
  if (typeof draw !== "bigint" || draw < 0n || draw >= RANDOM_RANGE) {
    throw new RangeError("random must return an unsigned 64-bit bigint");
  }
  let selected = Number(draw * BigInt(eligible) >> 64n);
  for (let edge = firstBestEdge; edge < PAIRS.length; edge += 2) {
    const a = PAIRS[edge];
    const n = PAIRS[edge + 1];
    const index = a * NOUN_COUNT + n;
    if (blocked[index >>> 3] & (1 << (index & 7))) continue;
    if (Math.max(adjectiveUses[a], nounUses[n]) !== bestMaximum || adjectiveUses[a] + nounUses[n] !== bestSum) continue;
    if (selected-- === 0) return { name: `${WORDS[a]}-${WORDS[ADJECTIVE_COUNT + n]}`, kind: "pair", eligible };
  }
  throw new Error("Name selection violated its counted-tier invariant");
}
