import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chooseName, normalizeName } from "../extension/name-generator.js";
import { ADJECTIVE_COUNT, NOUN_COUNT, WORDS, PAIRS } from "../extension/name-catalog.js";

const pack = JSON.parse(await readFile(new URL("../naming-data/en-v1.json", import.meta.url), "utf8"));
const words = [...pack.adjectives, ...pack.nouns];
const bySpelling = new Map(words.flatMap(word => [word.word, ...word.spellingVariants].map(spelling => [spelling, word])));
const names = pack.pairs.map(pair => `${pair.adjective}-${pair.noun}`);
const RANGE = 1n << 64n;
const MAXIMUM = RANGE - 1n;
const canonical = value => value.normalize("NFKC").toLowerCase().normalize("NFKC").split(/[\s_\p{Dash_Punctuation}\u2212]+/u).filter(Boolean).join("-");

// Deliberately simple oracle: full dynamic-programming edit distance, direct
// word-level predicates and a materialized candidate list, independent of the
// runtime's one-edit scan, Cartesian bitset and count/select passes.
function distance(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let index = 0; index <= a.length; index++) table[index][0] = index;
  for (let index = 0; index <= b.length; index++) table[0][index] = index;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1,
        table[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
  }
  return table[a.length][b.length];
}

function near(token, candidate) {
  const known = bySpelling.get(token);
  if (known) return known.id === candidate || known.confusableWith.includes(candidate);
  const word = bySpelling.get(candidate);
  return [word.word, ...word.spellingVariants].some(spelling => distance(token, spelling) <= 1);
}

function oracle(titles) {
  const occupied = new Set(Array.from(titles, canonical));
  const components = [...occupied].map(title => /^([^-]+)-([^-]+)$/u.exec(title)).filter(Boolean);
  const uses = id => components.reduce((count, match) => {
    const word = bySpelling.get(id);
    const token = match[word.role === "adjective" ? 1 : 2];
    return count + Number(bySpelling.get(token)?.id === id);
  }, 0);
  const count = new Map(words.map(word => [word.id, uses(word.id)]));
  const candidates = pack.pairs.filter(pair =>
    !occupied.has(`${pair.adjective}-${pair.noun}`) &&
    !components.some(([, a, n]) => near(a, pair.adjective) && near(n, pair.noun)))
    .map(pair => ({
      name: `${pair.adjective}-${pair.noun}`,
      max: Math.max(count.get(pair.adjective), count.get(pair.noun)),
      sum: count.get(pair.adjective) + count.get(pair.noun),
    }));
  const minimumMaximum = Math.min(...candidates.map(candidate => candidate.max));
  const minimumSum = Math.min(...candidates.filter(candidate => candidate.max === minimumMaximum).map(candidate => candidate.sum));
  return candidates.filter(candidate => candidate.max === minimumMaximum && candidate.sum === minimumSum).map(candidate => candidate.name);
}

function rankDraw(rank, count) {
  return (BigInt(rank) * RANGE + BigInt(count) - 1n) / BigInt(count);
}

function assertOracle(titles) {
  const expected = oracle(titles);
  assert(expected.length > 0);
  for (const rank of new Set([0, Math.floor(expected.length / 2), expected.length - 1])) {
    const actual = chooseName(titles, () => rankDraw(rank, expected.length));
    assert.deepEqual(actual, { name: expected[rank], kind: "pair", eligible: expected.length });
  }
  assert.equal(chooseName(titles, () => MAXIMUM).name, expected.at(-1));
  return expected;
}

// Make every component's exact-use count one so an exclusion cannot be hidden
// behind a lower-reuse tier. Filler's other slot is much longer than any word.
function balanced(title) {
  const [, a, n] = /^([^-]+)-([^-]+)$/u.exec(canonical(title));
  const countedA = bySpelling.get(a)?.role === "adjective" ? bySpelling.get(a).id : undefined;
  const countedN = bySpelling.get(n)?.role === "noun" ? bySpelling.get(n).id : undefined;
  return [title,
    ...pack.adjectives.filter(word => word.id !== countedA).map(word => `${word.id}-zzzzzzzzzzzzzzzzzzzzzzzz`),
    ...pack.nouns.filter(word => word.id !== countedN).map(word => `zzzzzzzzzzzzzzzzzzzzzzzz-${word.id}`),
  ];
}

test("compiled catalog preserves every approved edge and packaged license", () => {
  const editorial = spawnSync(process.execPath, [new URL("../naming-data/build-pack.mjs", import.meta.url).pathname, "--check"], { encoding: "utf8" });
  assert.equal(editorial.status, 0, editorial.stderr);
  assert.equal(ADJECTIVE_COUNT, pack.adjectives.length);
  assert.equal(NOUN_COUNT, pack.nouns.length);
  const compiled = Array.from({ length: PAIRS.length / 2 }, (_, index) =>
    `${WORDS[PAIRS[index * 2]]}-${WORDS[ADJECTIVE_COUNT + PAIRS[index * 2 + 1]]}`);
  assert.deepEqual(compiled, names);
  const result = spawnSync(process.execPath, [new URL("../scripts/compile-names.js", import.meta.url).pathname, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("normalization recognizes compatibility, case, spacing, underscores and dash variants", () => {
  for (const input of ["Sleepy Otter", " ＳＬＥＥＰＹ＿ＯＴＴＥＲ ", "__sleepy—–otter__", "sleepy\t\n otter", "sleepy−otter"]) {
    assert.equal(normalizeName(input), "sleepy-otter");
  }
  assert.equal(normalizeName(" \t_— "), "");
  assert.equal(normalizeName("sleepy-otter-extra"), "sleepy-otter-extra");
  assert.equal(normalizeName("café"), "café");
  assert.equal(normalizeName("H\u0331"), normalizeName("\u1e96"), "Case conversion can introduce a new composition opportunity");
  for (const input of ["\u1e96", "H\u0331", "İ", "ℌ", "___ ＳＬＥＥＰＹ — otter ___"]) {
    assert.equal(normalizeName(normalizeName(input)), normalizeName(input));
    assert.equal(normalizeName(input).normalize("NFKC"), normalizeName(input));
  }
});

test("every empty-context edge is reachable once by rank, despite unequal adjective degrees", () => {
  const seen = new Set();
  for (let rank = 0; rank < names.length; rank++) {
    const result = chooseName([], () => rankDraw(rank, names.length));
    assert.deepEqual(result, { name: names[rank], kind: "pair", eligible: names.length });
    seen.add(result.name);
  }
  assert.equal(seen.size, names.length);
  assert.equal(chooseName([], () => MAXIMUM).name, names.at(-1));
});

test("context deduplication and reuse tiers agree with independent oracle", () => {
  for (const titles of [
    [], ["mossy-lantern"], ["mossy-lantern", "sleepy-otter"],
    ["mossy-lantern", "MOSSY LANTERN", "___mossy_lantern___"],
    ["little-fox", "little-owl", "shiny-owl", "bright-flower", "holiday"],
    ["cosy-pillow", "wooly-mitten", "new research group"],
  ]) assertOracle(titles);
  assert.deepEqual(chooseName(["mossy-lantern"], () => 0n),
    chooseName(["mossy-lantern", "MOSSY LANTERN", "___mossy_lantern___"], () => 0n));
});

test("repeated components are discouraged without pretending counts measure memory", () => {
  const expected = assertOracle(["mossy-lantern", "sleepy-otter"]);
  for (const name of expected) {
    const [adjective, noun] = name.split("-");
    assert(!["mossy", "sleepy"].includes(adjective));
    assert(!["lantern", "otter"].includes(noun));
  }
});

test("pair exclusion combines sound, meaning and spelling only when both slots are near", () => {
  for (const [title, excluded] of [
    ["little-pond", "tiny-lake"],
    ["shiny-dune", "tiny-moon"],
    ["sleeqy-kitten", "sleepy-kitten"],
    ["cosy-pillow", "cozy-pillow"],
    ["wooly-mitten", "woolly-mitten"],
    ["feather-flower", "feathery-flower"],
    ["little-hazy", "tiny-daisy"],
    ["cosx-pillow", "cozy-pillow"],
    ["sleepy-kitt🐱n", "sleepy-kitten"],
  ]) {
    const expected = assertOracle(balanced(title));
    assert(!expected.includes(excluded), `${title} must exclude ${excluded}`);
  }
  const titles = balanced("sleepy-otter");
  const expected = assertOracle(titles);
  const rank = expected.indexOf("sleepy-fox");
  assert(rank >= 0, "One shared component alone is not a hard exclusion");
  assert.equal(chooseName(titles, () => rankDraw(rank, expected.length)).name, "sleepy-fox");
});

test("minimum maximum usage takes priority over total usage, then sum breaks ties", () => {
  // Uneven counts ensure this covers more than the frequent all-zero best tier.
  const titles = [];
  for (const [index, word] of pack.adjectives.entries()) {
    for (let count = 0; count < 2 + index % 3; count++) titles.push(`${word.id}-zzzzzzzzzzzzzzzzzzzzzzzz${count}`);
  }
  for (const [index, word] of pack.nouns.entries()) {
    for (let count = 0; count < 1 + index % 4; count++) titles.push(`zzzzzzzzzzzzzzzzzzzzzzzz${count}-${word.id}`);
  }
  assertOracle(titles);

  // Construct the consequential conflict explicitly: (2,2) has lower maximum
  // but higher sum than (3,0). Misspelled occupied pairs block other waterfall
  // edges without counting an exact use of either component.
  const conflict = pack.pairs.filter(pair => pair.noun === "waterfall" && pair.adjective !== "bubbly")
    .map(pair => `${pair.adjective}q-waterfallq`);
  for (const word of pack.adjectives) {
    for (let count = 0; count < (word.id === "bubbly" ? 3 : 2); count++) {
      conflict.push(`${word.id}-zzzzzzzzzzzzzzzzzzzzzzzz${count}`);
    }
  }
  for (const word of pack.nouns.filter(word => word.id !== "waterfall")) {
    for (let count = 0; count < 2; count++) conflict.push(`zzzzzzzzzzzzzzzzzzzzzzzz${count}-${word.id}`);
  }
  const expected = assertOracle(conflict);
  assert(!expected.includes("bubbly-waterfall"), "A lower sum cannot override the lower maximum");
  assert(expected.every(name => !name.startsWith("bubbly-") && !name.endsWith("-waterfall")));
});

test("manual spelling comparison covers insertions, deletions and substitutions", () => {
  for (const manual of ["sleep-kitten", "sleepyy-kitten", "sleeqy-kitten", "sleepy-kiten", "sleepy-kittqen"]) {
    const expected = assertOracle(balanced(manual));
    assert(!expected.includes("sleepy-kitten"), manual);
  }
  const titles = balanced("slqqpy-kitten");
  const expected = assertOracle(titles);
  assert(expected.includes("sleepy-kitten"), "Two unknown-word spelling edits are outside the hard rule");
});

test("fallback has exact normalized uniqueness and chooses the smallest free decimal suffix", () => {
  const failRandom = () => { throw new Error("Fallback must not draw randomness"); };
  assert.deepEqual(chooseName(names, failRandom), { name: "stack-1", kind: "numbered", eligible: 0 });
  const context = [...names, " STACK_1 ", "stack—2", "stack-4", "stack-04", "stack-0"];
  assert.deepEqual(chooseName(context, failRandom), { name: "stack-3", kind: "numbered", eligible: 0 });
  const many = [...names, ...Array.from({ length: 2048 }, (_, index) => `stack-${index + 1}`)];
  assert.equal(chooseName(many, failRandom).name, "stack-2049");
});

test("long arbitrary manual titles and single-use iterables are preserved as supported input", () => {
  const long = "x".repeat(1_000_000);
  const titles = [long, `${long}-kitten`, `sleepy-${long}`, `${long}-${long}`, "prefix-many-extra-components-title"];
  function* once() { yield* titles; }
  const result = chooseName(once(), () => 0n);
  assert.equal(result.kind, "pair");
  assert(names.includes(result.name));
  assert(!titles.map(canonical).includes(result.name));
  // Unknown long tokens do not block pairs; known exact components still affect reuse.
  assert(!result.name.startsWith("sleepy-"));
  assert(!result.name.endsWith("-kitten"));
});

test("random input has an explicit unsigned 64-bit contract and errors propagate", () => {
  for (const value of [-1n, RANGE, 0, undefined]) assert.throws(() => chooseName([], () => value), RangeError);
  const error = new Error("entropy unavailable");
  assert.throws(() => chooseName([], () => { throw error; }), caught => caught === error);
  const result = chooseName([]);
  assert(names.includes(result.name));
});

test("a unique best edge needs no random draw", () => {
  // Independently establish singleton eligibility using the existing materialized
  // oracle before checking that entropy is unnecessary.
  const titles = names.slice(0, 669);
  const expected = oracle(titles);
  assert.equal(expected.length, 1);
  assert.deepEqual(chooseName(titles, () => { throw new Error('Unexpected entropy request'); }),
    { name: expected[0], kind: 'pair', eligible: 1 });
});
