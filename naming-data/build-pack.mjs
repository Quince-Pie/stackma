import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Offline editorial data build; runtime assignment does not load these sources.
const directory = new URL(".", import.meta.url);
const read = (name) => readFile(new URL(name, directory), "utf8");
const [curationText, pronunciationText, licenseText] = await Promise.all([
  read("curation.json"),
  read("cmu-pronunciations.dict"),
  read("CMU-LICENSE.txt"),
]);
const curation = JSON.parse(curationText);
const digest = (text) => createHash("sha256").update(text).digest("hex");
assert.equal(
  digest(pronunciationText),
  "e4f211be179351235d79bb0f55171d6494100ce627d710fa962e211577d9da8d",
  "Pronunciations must remain the audited pinned CMU excerpt",
);
assert.equal(
  digest(licenseText),
  "bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a",
  "Keep the upstream license unmodified",
);

const pronunciations = new Map();
for (const line of pronunciationText.trim().split("\n")) {
  const [sourceWord, ...phones] = line.trim().split(/\s+/u);
  const word = sourceWord.replace(/\(\d+\)$/u, "");
  assert.match(word, /^[a-z]+$/u);
  assert(phones.length > 0);
  assert(phones.every((phone) => /^[A-Z]+[012]?$/u.test(phone)));
  const variants = pronunciations.get(word) ?? [];
  variants.push(phones);
  pronunciations.set(word, variants);
}

function distance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    const next = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
      next[rightIndex + 1] = Math.min(
        previous[rightIndex + 1] + 1,
        next[rightIndex] + 1,
        previous[rightIndex] + Number(left[leftIndex] !== right[rightIndex]),
      );
    }
    previous = next;
  }
  return previous[right.length];
}

const reviewStatus = "editorial-ai-reviewed; no human outcome study";
const roleWords = (role, rows) => rows.map(([word, semanticFamily, sense]) => {
  assert.match(word, /^[a-z]+$/u);
  assert(pronunciations.has(word), `No pinned pronunciation for ${word}`);
  const variants = pronunciations.get(word);
  return {
    id: word,
    word,
    role,
    sense,
    semanticFamily,
    spellingVariants: curation.spellingVariants[word] ?? [],
    pronunciations: variants,
    syllables: [...new Set(variants.map((phones) =>
      phones.filter((phone) => /[012]$/u.test(phone)).length))].sort((a, b) => a - b),
    confusableWith: [],
    confusionReasons: {},
    reviewStatus,
  };
});
const adjectives = roleWords("adjective", curation.adjectives);
const nouns = roleWords("noun", curation.nouns);
const words = [...adjectives, ...nouns];
const byWord = new Map(words.map((word) => [word.id, word]));
assert.equal(byWord.size, words.length, "Word IDs must be unique across roles");
assert.equal(pronunciations.size, words.length, "The excerpt must contain exactly the chosen words");
const adjectiveIds = new Set(adjectives.map((word) => word.id));
const nounIds = new Set(nouns.map((word) => word.id));
const excludedStatusWords = new Set([
  "admin", "administrator", "approved", "authorized", "encrypted", "official",
  "private", "production", "protected", "safe", "saved", "secure", "shared", "trusted",
]);
const nativeColorTokens = new Set([
  "blue", "purple", "cyan", "orange", "yellow", "pink", "green", "gray", "grey", "red",
]);
for (const word of words) assert(!excludedStatusWords.has(word.id));
for (const word of adjectives) assert(!nativeColorTokens.has(word.id));
for (const group of curation.semanticNeighborSets) {
  assert(group.length >= 2);
  assert(group.every((word) => byWord.has(word)));
}

const phonemes = (word) => word.pronunciations.map((variant) =>
  variant.map((phone) => phone.replace(/[012]$/u, "")));
for (let leftIndex = 0; leftIndex < words.length; leftIndex++) {
  const left = words[leftIndex];
  for (let rightIndex = leftIndex + 1; rightIndex < words.length; rightIndex++) {
    const right = words[rightIndex];
    const reasons = [];
    const leftSpellings = [left.word, ...left.spellingVariants];
    const rightSpellings = [right.word, ...right.spellingVariants];
    if (leftSpellings.some((a) => rightSpellings.some((b) => distance(a, b) <= 1))) {
      reasons.push("spelling-edit-distance-at-most-one");
    }
    if (phonemes(left).some((a) => phonemes(right).some((b) => distance(a, b) <= 1))) {
      reasons.push("stressless-cmu-phoneme-edit-distance-at-most-one");
    }
    if (curation.semanticNeighborSets.some((group) => group.includes(left.id) && group.includes(right.id))) {
      reasons.push("editorial-semantic-neighbor");
    }
    if (reasons.length === 0) continue;
    left.confusableWith.push(right.id);
    right.confusableWith.push(left.id);
    left.confusionReasons[right.id] = reasons;
    right.confusionReasons[left.id] = reasons;
  }
}

const pairs = [];
const pairReviews = [];
const pairIds = new Set();
for (const [adjective, nounText, rationale] of curation.approvedPairs) {
  assert(adjectiveIds.has(adjective));
  const reviewedNouns = nounText.split(" ");
  assert.equal(new Set(reviewedNouns).size, reviewedNouns.length);
  pairReviews.push({
    adjective,
    nouns: reviewedNouns,
    rationale,
    interpretability: "editorially acceptable",
    familiarity: "not measured; ordinary collocations remain eligible",
    imageability: "editorially acceptable integrated image",
    appropriateness: "editorially acceptable as a non-secret tab-group label",
    reviewStatus,
  });
  for (const noun of reviewedNouns) {
    assert(nounIds.has(noun), `Unknown noun ${noun}`);
    const name = `${adjective}-${noun}`;
    assert.match(name, /^[a-z]+-[a-z]+$/u);
    assert(!pairIds.has(name), `Duplicate pair ${name}`);
    pairIds.add(name);
    pairs.push({ adjective, noun });
  }
}
assert.equal(new Set(pairReviews.map((review) => review.adjective)).size, adjectives.length);
assert.equal(new Set(pairs.map((pair) => pair.noun)).size, nouns.length);
const lengths = pairs.map(({ adjective, noun }) => adjective.length + 1 + noun.length);
const syllableCounts = pairs.flatMap(({ adjective, noun }) =>
  byWord.get(adjective).syllables.flatMap((a) => byWord.get(noun).syllables.map((n) => a + n)));
const pack = {
  schemaVersion: 1,
  version: "en-v1",
  language: "en",
  spellingPolicy: "ASCII lowercase; US cozy and internationally used woolly; explicit variants",
  pronunciationScope: "CMU American English; accent coverage is incomplete",
  reviewStatus,
  provenance: {
    pronunciation: {
      source: "CMU Pronouncing Dictionary",
      repository: "https://github.com/cmusphinx/cmudict",
      revision: "74790861f652b15e4ac49015a90074ad62a27690",
      dictionaryUrl: "https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690/cmudict.dict",
      dictionarySha256: "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22",
      excerptSha256: digest(pronunciationText),
      licenseFile: "CMU-LICENSE.txt",
      licenseSha256: digest(licenseText),
    },
    curationSha256: digest(curationText),
    designReference: "/home/quince/Downloads/Pro.md supplied by the user",
    inspectedEngineeringPrecedent: "https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases",
  },
  measurements: {
    componentFrequency: null,
    phraseFrequency: null,
    contextualDiversity: null,
    ageOfAcquisition: null,
    concretenessNorm: null,
    affectNorm: null,
    humanRecognitionOrRecall: null,
    note: "Null means unmeasured, not zero. No familiarity or memorability score is invented.",
  },
  confusionPolicy: {
    spelling: "Levenshtein distance <= 1 over canonical forms and explicit variants",
    sound: "Minimum Levenshtein distance <= 1 over all pinned CMU phoneme sequences after removing stress digits",
    semantic: "Explicit sets in curation.json; semanticFamily is an additional descriptive category, not measured confusion",
    interpretation: "Screening features, not probabilities or a validated cognitive distance",
  },
  statistics: {
    adjectives: adjectives.length,
    nouns: nouns.length,
    approvedPairs: pairs.length,
    unrestrictedCartesianPairs: adjectives.length * nouns.length,
    minCharacters: Math.min(...lengths),
    maxCharacters: Math.max(...lengths),
    minSyllables: Math.min(...syllableCounts),
    maxSyllables: Math.max(...syllableCounts),
    outsideSoftSyllableTarget: syllableCounts.filter((count) => count < 3 || count > 5).length,
    note: "Statistics describe the approved set; they are not human-performance measurements.",
  },
  adjectives,
  nouns,
  pairs,
  pairReviews,
};
const generated = `${JSON.stringify(pack, null, 2)}\n`;
if (process.argv.includes("--check")) assert.equal(await read("en-v1.json"), generated, "Regenerate the editorial pack");
else await writeFile(new URL("en-v1.json", directory), generated);
console.log(JSON.stringify(pack.statistics));
