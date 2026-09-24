# English naming pack v1

This is a deliberately limited, versioned editorial vocabulary for the design in
the user-supplied `Pro.md`. It contains **47 attributive adjectives, 86 singular
concrete noun senses, and 858 explicit approved pairs**. The unrestricted product
would contain 4,042 pairs; it is not used. `en-v1.json` is the generated data,
`curation.json` is the reviewable source, and `build-pack.mjs` reproduces the data
without a network connection or third-party packages.

```sh
node naming-data/build-pack.mjs
```

The build checks source identities, roles, canonical spelling, pronunciation
coverage, edge uniqueness, noun coverage, reserved words, and exact native color
tokens. It derives character counts, syllable counts, and explicit spelling and
sound neighbors. A runtime compiler may strip prose and use numeric word indexes;
the approved edge set and exclusions must survive that transformation.

## What was reviewed

Each explicit adjective list in `approvedPairs` was read as complete phrases,
using its recorded intended sense. The review asks whether the adjective can
naturally modify the noun, whether both words form one easy-to-imagine thing,
and whether the whole phrase avoids a misleading security, ownership, persistence
or administrative claim. The per-adjective rationale explains the shared sense
for its separately listed nouns. `little` and `tiny` legitimately cover the noun
set, but this was an explicit editorial choice, not a rule permitting every other
adjective to do so.

The review is **AI editorial review**, not a human panel, a population norm, or an
experiment. Interpretability, familiarity, imageability, and appropriateness are
kept separate. No frequency, age-of-acquisition, concreteness, affect, recall,
recognition, spelling-error, or task-time measurements were performed on this
pack. Their values are `null`, meaning unmeasured. No invented aggregate
memorability score is supplied.

Familiar appearance, texture, material, physical size, weather, motion and animal
state words provide the adjectives. Nouns denote familiar physical things, plants,
animals, places or visible phenomena. Ordinary combinations remain eligible;
neither novelty nor alliteration receives a bonus. The intended sense resolves
polysemy, such as an insect `cricket`, a wax `candle`, or a physical `clock`.

The product context excludes words such as `private`, `saved`, `shared`, `secure`
and `admin`. Exact Firefox palette tokens are excluded as adjectives to avoid
implying a matching group color. `golden` and `silver` describe an imagined
material or appearance and do not set Firefox color. Whole phrases were reviewed;
a blocklist alone does not certify appropriateness.

Specific review corrections included removing `pebbly` because the pinned
dictionary lacked a pronunciation, removing `wooden-candle` and `wooden-bell`
because their natural noun senses were strained, and restricting `leafy` to
readily leafy plants and places. This is a quality boundary rather than a target
word-count exercise. It is not a comprehensive dictionary or a universal safety
filter.

All names use lowercase ASCII letters and one ordinary hyphen. They contain
7–18 characters. Pronunciation variants span 2–6 syllables: the only pair with a
six-syllable variant is `bubbly-waterfall`. The lower and upper exceptions retain
clear, familiar words because `Pro.md` expressly makes 3–5 syllables a soft
engineering budget, not an established memory optimum. The aggregate exception
count includes each pronunciation combination and is not a count of distinct
pairs.

## Pronunciation provenance and licensing

Pronunciations are verbatim selected entries from the maintained
[CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict), repository HEAD
observed on 2026-09-23 and pinned to revision
`74790861f652b15e4ac49015a90074ad62a27690`. All dictionary variants for selected words
are preserved. `cmu-pronunciations.dict` contains only that excerpt; the full
dictionary is not needed for normal builds.

| Input | SHA-256 |
| --- | --- |
| [Full pinned dictionary](https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690/cmudict.dict) | `81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22` |
| [Upstream license](https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690/LICENSE) | `bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a` |

The generated pack records the excerpt and editorial source hashes as well.
The excerpt can be audited by selecting full-dictionary rows whose unnumbered
entry matches one of the word IDs; alternate entries have a parenthesized numeric
suffix. No phonetic transcription was invented to fill gaps.

CMU's complete copyright notice, redistribution conditions and disclaimer are in
`CMU-LICENSE.txt`. Retain that file in source distributions and reproduce it in
the extension package when distributing generated pronunciation data or derived
metadata. The original editorial selections, senses and pair decisions are
project-authored and covered by the project's [WTFPL license](../LICENSE).
That grant does not replace the CMU terms for the pronunciation data or
derived metadata. EFF vocabulary is not copied into this pack.

CMU is an American English resource and explicitly does not guarantee complete
accuracy. It does not establish correctness for every accent. The pack includes
`cosy` as a spelling variant of `cozy`, and `wooly` as a variant of `woolly`; these
are recognition metadata, not alternate generated labels. Lexical IDs are stable
within this data version and are separate from Firefox's group IDs.

## Confusion features and their limits

The build records symmetric, explainable neighbor links for:

- Levenshtein spelling distance at most one, considering listed spelling variants.
- Minimum phoneme-sequence edit distance at most one across CMU variants, after
  removing stress markers.
- Explicit editorial semantic-neighbor sets, for example `little` / `tiny`,
  `lake` / `pond`, and `flower` / `blossom`.

These catch examples such as `kitten` / `mitten`, `pillow` / `willow`, and
`glassy` / `grassy`. A word's descriptive `semanticFamily` is also supplied. It
is broader than the explicit neighbor links and is not proof of confusion.
Cross-role links are retained, for example `feathery` / `feather`; a runtime
policy can decide whether they matter when the word positions differ.

These thresholds are conservative engineering screening features. Neither edit
distance nor a semantic category is a validated cognitive distance. Missing a
link does not establish human distinguishability. Local assignment must also
consider exact occupied names, component reuse, recombination, scope and
exhaustion. No assignment or fallback implementation lives in this directory.

## Evidence and qualification boundary

The directly inspected [EFF design account](https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases)
supports using familiarity and concreteness screening, checking spelling and
homophones, and distinguishing usability hypotheses from demonstrated results.
Its task is passphrases; it does not validate this vocabulary for Firefox groups.
The supplied `Pro.md` argues for approved phrases and context-sensitive assignment
while explicitly leaving the winning vocabulary and thresholds unestablished.
The Jacobs, Dell and Bannard
[publication record](https://researchconnect.buffalo.edu/en/publications/phrase-frequency-effects-in-free-recall-evidence-for-redintegrati/)
was inspected to confirm the identity of its phrase-frequency reference; its
abstract was not treated as validation of this pack.

The pack implements the requested editorial and structural design. It does not
establish superiority over noun–noun, three-word, native unnamed, or other
adjective–noun schemes for human use. That requires the task-based human trials
described in `Pro.md`, with real tab-group identification, delayed association,
spoken and visual channels, accessibility coverage and held-out phrases. No such
trials are claimed. The English audience assumption and incomplete accent/norm
coverage remain visible rather than being converted into fictitious scores.
