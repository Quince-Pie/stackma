# Naming qualification record

## Scope, authority and artifacts

This feature follows the user-supplied [Pro.md](Pro.md), SHA-256
`498f76151c221a0fde7c32748e060a654d5a551f1e4d787c42147f0e3ffb0bb6`.
The before/after contract and pre-comparison selection rule are in
[naming-design.md](naming-design.md). Version 1.0.1 left newly created groups
unnamed. Version 1.1.0 names only newly created Stackma groups. Join/reuse,
manual metadata, native colors, pins, windows and browser-reported-source policy
retain their established meaning. This is an English non-secret alias feature.

Reference identities:

- Firefox 156.0 tag `FIREFOX_156_0_RELEASE`, commit
  `3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1`.
- Supplied newer Firefox checkout `9e9b5f17f56187c1f5c8b9cdf79a01ff51a7b643`
  (158.0a1); relevant tabs/tabGroups schema and parent API implementations match
  the target. No conditional title-update fix is present there.
- Supplied MDN content `8530cf97b809705c3524e733afcb69124b305b2e`, especially
  `files/en-us/mozilla/add-ons/webextensions/api/tabgroups/{tabgroup,update,onupdated}`.
- CMU pronunciation source and license are pinned in the
  [word-pack record](../naming-data/README.md). The pack carries explicit
  unmeasured values rather than inventing frequency or human-outcome scores.

## Mechanism trace

| Requirement / claim | Delivered mechanism | Evidence / limit |
| --- | --- | --- |
| Approved coherent pairs, not Cartesian concatenation | 47 role/sense-tagged adjectives, 86 singular noun senses, 858 explicit edges | `curation.json`, offline builder, edge-for-edge compiler oracle; AI editorial review, not human norms |
| Familiarity separate from sampling probability | No frequency weights; approximately uniform draw among current best-tier edges | Every catalog edge reachable by rank; unequal row degrees verified |
| Local distinction | Context normalization; 506-byte Cartesian conflict mask; reviewed spelling, pronunciation and semantic links in both slots | Independent full edit-distance oracle; arbitrary manual-language sounds/meanings remain uncovered |
| Discourage component concentration | Lexicographic minimum of maximum component usage and then sum | Explicit (3,0) versus (2,2) conflict test; heuristic, not cognitive distance |
| Stable assignment | Write native title once; no persistent ID-to-name authority map | Native title is read as authority, joins/reuse never invoke naming; Firefox SessionStore persists names |
| Internal uniqueness | Query → choose → session reservation → write serializes within each privacy class | Concurrent-window tests, duplicates include pending reservations through the lane; external writers cannot be locked out |
| Preserve metadata/manual decisions | Only `{title}` passed to tabGroups.update; observed rename/move/removal cancels; observed assignment ends authority even after a lost reply | Metadata tests and failure-injection regressions; no native compare-and-swap |
| Failure isolation | Creation hook outside membership retry; followup promises tracked independently | Naming rejection does not replay grouping or stall that window's later membership work |
| Ambiguous creation receipt | Retry may recover membership, but cannot infer ownership of an observed group | A rejected-after-commit creation is reported and left unnamed; source ordinary path is synchronous, fault model broader |
| Privacy and lifecycle | Two session histories, maximum 64 aliases each; private close removes that window's entries; no manual titles stored | Actual private/normal Firefox tests and close-during-write oracle; storage failure caveat below |
| Copy/search/entity selection | Full native labels, literal substring search, explicit ID-bound open, rendered-title copy during user activation | DOM interaction tests and actual Firefox trusted copy/search/navigation; no fuzzy substitution |
| Exhaustion | First unoccupied `stack-N`, explicitly described in the popup | At most occupied-count + 1 tests; exact uniqueness, no mnemonic or phonetic distinction claim |

Firefox 156 source paths inspected:

- `browser/components/extensions/parent/ext-tabGroups.js`: permission/access
  checks, event conversion, query/get/update; update assigns only provided fields
  synchronously and offers no expected-title argument.
- `browser/components/extensions/parent/ext-tabs.js:1717`: group validation,
  synchronous native creation and numeric-ID return. The extension names only
  after receiving that return, never from an ambiguous observed group alone.
- `browser/components/tabbrowser/content/tabgroup.js`: label setter and
  TabGroupUpdate; a color/collapse event is not evidence of a title edit.
- `browser/components/sessionstore/TabGroupState.sys.mjs`: collects native name;
  SessionStore's group restoration returns it to native creation. API group IDs
  are not promised stable across restore and are never truncated to 32 bits.
- `toolkit/components/extensions/ExtensionStorage.sys.mjs`: session WeakMap and
  quota; session tests confirm add-on reload clears it. It is shared across
  normal/private extension contexts, so the code separates its own histories.
- `dom/events/Clipboard.cpp` and `dom/base/nsContentUtils.cpp`: transient user
  activation permits clipboard writing without a clipboardWrite permission.

## Current alternatives and decisive mechanisms

Primary implementation source coverage was inspected at pinned identities, rather
than inferring guarantees from names such as “unique”. These are engineering
controls, not evidence that their users have worse memory.

| Family / source | Actual mechanism, advantage and cost | Disposition within this contract |
| --- | --- | --- |
| [unique-names-generator 4.7.1](https://github.com/andreasonny83/unique-names-generator/blob/10ff70b131c8a080e88c315a55e45a0f5caadd24/src/unique-names-generator.constructor.ts) | Independent dictionary selections; inexpensive, configurable/seeded | Conventional control fails approved-pair and contextual occupancy rules |
| [human-id 4.1.4, Aug 2026](https://github.com/RienNeVaPlus/human-id/blob/d9d147a267c4ce048bfb4dab1b996a36b0c9b012/index.ts) | Independent adjectives/plural nouns/verb via Math.random | Different grammar and no context reservation; not a drop-in contender |
| [golang-petname, Feb 2026](https://github.com/dustinkirkland/golang-petname/blob/f0c533e9ce9b17d561689476f39699391102bfc0/petname.go) | Independent adverb/adjective/animal words | Runtime port would not supply pair approval, local distinction or appropriate status vocabulary |
| [unique-username-generator](https://github.com/subhamg/unique-username-generator/blob/95c52db6174013eaeccaab6d42809623fad9feea/src/index.ts) | Up to 1,000 trials with async isTaken | Can fail despite free aliases; no atomic reservation across callers |
| [coolname 5.0.1 development](https://github.com/alexanderlukanin13/coolname/blob/7f895eed330e39830d7042ee03395a332495480c/src/coolname/_impl.py) | Compositional grammar weighted by exact subspace cardinality, approved phrase lists; then rejection in generator | Cardinality-preserving selection retained in flat approved edges; unrestricted retry replaced by complete bounded enumeration |
| [MASCARA implementation](https://github.com/Mainack/MASCARA-passphrase-code-data/blob/a3283baf6967629118badef9a2bb736d39c4df9d/CODE-MASCARA-MEMORABLE-PASSPHRASE-GENERATION/mascara.py) | Bigram-constrained longer phrases, weighted CDF transitions | Different secret/passphrase task and no occupied-resource context; code differs from paper's displayed uniform transitions/thresholds, so results cannot transfer |
| Array and compact Uint16 eligible arrays | One scan and direct selection; up to 858 candidate offsets | Strong conventional contract-matching controls; extra candidate state remains visible in comparison |
| Reservoir, direct and buffered crypto draws | One scan, constant candidate state; random work per candidate in current tier | Constant-state challenger; buffered variant fairly avoids a crypto call for every draw, at the cost of 256 bytes retained RNG state |
| Bounded rejection plus complete fallback | Scan to establish best tier, up to 8 random catalog probes, then counted selection | Strong dense-tier challenger; same lexical rules and bounded progress, more random work near exhaustion |
| Cached shuffled decks / event-maintained group cache | Amortize filtering or native reads | Add retained O(E) or O(G) state and initialization/event-reconciliation invariants; still must handle arbitrary manual edits/restores. User's lower-state priority favors fresh context; no claim of universally lower latency |
| Precomputed conflict representations | Bitsets avoid testing every candidate against every contextual phrase | Applied: numeric role neighbors + a compact Cartesian bitset. Full edge-by-edge conflict matrix would add substantially more retained state without removing context reads |
| Runtime learned/Markov generators | Potentially larger output space | Cannot replace explicit pair approval/context/reservation; offline assistance remains possible, not required for this fixed design |

The [EFF primary word-list design](https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases)
supports screening recognition, concreteness, spelling and homophones, and itself
leaves usability superiority for further study. [MASCARA's full paper](https://pages.cs.wisc.edu/~chatterjee/papers/asiaccs23-mascara.pdf)
includes longer secrets, choice among alternatives and practice; its outcomes do
not establish two-word tab-group binding. Jacobs/Dell/Bannard's phrase-recall
[primary article](https://pmc.ncbi.nlm.nih.gov/articles/PMC5734641/) supports testing
familiar combinations, not a measured Stackma vocabulary optimum. Its indexed
methods/results were accessible during review; direct access subsequently met a
browser challenge. No unexamined result is inherited as a feature guarantee.

## Cost and progress argument

Let E=858 approved edges, A=47 adjectives, N=86 nouns, and C be distinct normalized
context titles (open groups in the privacy class plus at most 64 recent aliases).
Catalog pairs occupy 1,716 bytes of integer payload; role counts occupy 1,064
bytes; the per-call Cartesian bitset occupies ceil(A*N/8)=506 bytes. These are
payload counts, not a fabricated JS heap or RSS measurement. Normalized strings,
Set/object overhead, shared word strings and IPC snapshots are additional.

The selector normalizes all input, matches only two-component titles, sets
conflict bits, then scans E edges twice without retaining eligible offsets. Long
unknown tokens fail a length bound before code-point allocation or vocabulary
comparison. There is no per-candidate name-string allocation until output and no
random retry in the delivered two-pass selector. Arbitrary-length titles remain
permitted; normalization cost is proportional to input bytes/code units.

One successful naming attempt normally uses two native group reads, one all-group
query, one window-metadata query, one session-history read/write, and one title
update. No tab enumeration or page titles are needed for naming. Firefox still
owns allocation, native mutations, storage and IPC scheduling. Operations depend
on those promises settling; neither naming nor grouping is claimed lock-free,
wait-free, crash-atomic, or bounded in wall-clock time. Finite input gives bounded
extension-side computation and at most one title-write retry.

Within each privacy lane, no second assignment starts before the earlier job's
reservation and title work settle. The lane therefore provides internal
reservation serialization. It is not an atomic transaction with external manual
renames, another extension, session restore, or native tab movement. The last
fresh read/cancellation check is explicitly a check/commit boundary, not a CAS.
On removal/failure the pending record is released. Settled membership jobs drop
their followup closures/promises. Session history has a fixed 64-entry horizon;
private-close cleanup runs behind in-flight private assignments so a delayed
write cannot resurrect a closed window's entries.

If cleanup's storage read/write/removal fails, the error is reported and private
generated history may remain in session RAM until a later private assignment
filters closed-window entries, or the extension/browser session ends. Stackma
never writes it to storage.local or a file. Browser process crashes and add-on
unload can lose a pending assignment. Unowned blank groups are never adopted on
startup. These limits do not justify rewriting manual names.

## Evidence and acceptance scope

Numerical comparison results and final revision hashes are in the
[performance record](naming-performance.md). Independent selector oracles use full edit-distance
matrices and materialized approved candidates; they do not merely restate the
optimized mask or two-pass implementation. Failure injection covers observed
rename/clear, moved/removed groups, storage/title failures, lost replies, queue
release, and naming/grouping isolation. Actual Firefox tests cover native API
behavior and extension-page clipboard/search/navigation. Popup tests run the
actual popup page in an extension tab, not a screen-reader or full toolbar-panel
usability study. Add-on reload/suspension were exercised; full OS/browser restart
is supported by inspected native persistence paths rather than a new restart test.

Engineering verification can establish the stated alias contract within the
accepted Firefox API boundary. Selection qualification is scoped to the supported
platform, fixed pack, declared state priority and tested workloads. Human outcome
superiority, exact winning thresholds/word list, and literal universal optimality
remain unestablished. The [fixed human trial protocol](naming-human-evaluation.md)
is the remaining gate for a broader behavioral “SOTA” claim, not substitute data.

## Native identity discovery and guarded failure policy

The verified native defect is [Mozilla bug 1960104](https://bugzilla.mozilla.org/show_bug.cgi?id=1960104).
The live [Bugzilla REST record](https://bugzilla.mozilla.org/rest/bug/1960104),
checked 2026-09-23, reported ASSIGNED, unresolved, last changed
2026-09-16T22:31:55Z, with no fixed milestone. The cached HTML's NEW state was
stale. [D326236](https://phabricator.services.mozilla.com/D326236) proposes a
persisted sequential ID counter and currently needs revision. Neither a proposed
patch nor the inspected 158 checkout establishes a released fix.

Target `Tabbrowser.sys.mjs::addTabGroup` forms IDs as timestamp plus a rounded
random value from 0 through 100, without a uniqueness check. `getTabGroupById`
and extension get/update resolve the first matching ID. The actual Firefox
fixture in `scripts/native-id-test.js` guarantees a collision by creating 102
groups with a synchronously fixed timestamp, then restores the clock. It proves
separate DOM/native group objects can share an extension ID and that updating the
second one's numeric ID affects the first. The guarded delivered namer, stacker
and popup were then verified to leave those groups intact and report/refuse the
ambiguous operation. This is a controlled mechanism test, not a failure-frequency
measurement or attribution of an earlier unexplained benchmark failure.

The shared `group-id-guard.js` computes duplicates from all accessible native
rows, before filtering normal/private context. Naming still retains all titles
in its selection context, even if some *other* groups have colliding IDs. Native
queries are reused for identity validation, but only the ambiguous-ID Set and an
event epoch persist. No full name/group cache is retained by the production
coordinator. An old in-flight query cannot publish into a newer epoch or serve a
validator that started in that newer epoch. Caller-owned failures remain subject
to the existing one-retry grouping policy. An observed ambiguous target is left
unchanged; external creation after the checked snapshot remains the unavoidable
public API check/commit interval.

### Event ordering used by the identity guard and cache challenger

For active, registered Firefox 156 listeners, a mutation preceding the parent's
synchronous target GET body queues its event before the GET reply. Trace:

1. Native `TabGroupUpdate`/lifecycle dispatch reaches the extension event manager.
2. `ExtensionCommon.sys.mjs:2795` queues `fire.async` as a parent microtask.
3. `ExtensionParent.sys.mjs:1359` sends RunListener; API results send CallResult
   from the later `.then` reply (`:1268` onwards).
4. Both use the same Conduits actor and unprioritized PWindowGlobal RawMessage.
   `ConduitsParent.sys.mjs:349` batches webRequest only, not tabGroups events.
5. `ExtensionChild.sys.mjs:860` invokes the listener synchronously; `:848`
   separately resolves the API promise. `MessageChannel.cpp:1113` appends pending
   messages in order. JSActor.cpp and PWindowGlobal.ipdl confirm this route.

This establishes invalidation before the awaiting code resumes for mutations
before the native read. It does not establish that every edit occurring before
the *reply arrives* is already visible: edits after the read belong to the usual
check/commit interval. Listener registration is synchronous; first use reads
fresh native state; event-page recreation discards caches. Persistent startup
priming/registration replay and background listener initialization were also
inspected. Relevant newer source differences were comments/profiling, not this
mechanism. This is a scoped implementation argument, not a cross-version API
promise; a future Firefox upgrade must recheck it.

### Challenger correction and evidence invalidation

An early burst-cache confirmation hit its unique-family oracle once, before the
failure record included the offending IDs/titles. Its cause remains unconfirmed.
The instrumented repeat passed. That repeat does not erase the failure and the
native-ID defect is not asserted to have caused it.

The original cache representation was independently found to collapse colliding
IDs into one Map row, losing a title. The corrected contender retains all native
rows, computes global ambiguous IDs before privacy filtering, cancels pending ID
reuse, and invalidates on every creation including empty groups. Its corrected
34-case suite passes. Earlier exploratory and pre-guard measurements are kept
under explicit filenames; they do not qualify the corrected delivered pipeline.
Fresh final comparisons use the shared identity guard on both coordinators.

The cache can reduce queries, but retains O(groups + windows + ambiguous IDs)
metadata across a busy naming lane and requires epoch, lifecycle, own-write and
row-update invariants. Both coordinators release context at idle. The delivered
fresh-reader follows the user's retained-state priority and obtains group names
anew per assignment; it does not claim lower physical peak heap or universal
latency dominance over the cache. The comparison keeps that tradeoff visible.

## Delivery gate record

The [delivery manifest](../evidence/naming-delivery.json) ties the package,
source hashes, native reports and final comparison inputs to the same revision.
The unsigned `dist/stackma-1.1.0.xpi` is 23,873 bytes, SHA-256
`896566be9e7a9b83076690c43473bcbca83f85b5d20d7e10726a90e5067e830f`.
Two clean build invocations produced identical bytes; Firefox installed the XPI,
verified every packaged source hash, and grouped/named a real related pair.
The pre-feature v1.0.1 package/source remains recoverable in
`artifacts/naming-baseline/`; prior evidence remains in `evidence/v1.0.1/`.

Passed checks on the delivered sources:

- Strict checkJs/TypeScript, 147 tests (including 34 corrected cache-contender
  checks), and Mozilla lint with no errors, warnings or notices.
- 74 existing grouping-alternative checks.
- 20 general Firefox cases, eight native metadata cases, and 15 naming/popup
  cases, all in isolated Firefox 156 profiles.
- The additional deterministic native-ID fixture verifies the platform defect
  and the delivered naming, grouping and popup protections against it.
- Catalog/CMU-license integrity, offline reproduction, final comparator oracles,
  package integrity and byte-identical builds.

Engineering contract/verification: satisfied within the documented Firefox API
boundaries, with reported, non-destructive refusal when native identity is
ambiguous. Automatic assignment cannot be guaranteed for an object the public
API cannot uniquely address. The ordinary native algorithm and metadata paths,
as well as this explicit failure path, were exercised.

Engineering frontier qualification: scoped to the requested English design,
Firefox 156 and the declared retained-state/bounded-work preference. Strong
contract-matching selectors and the repaired cache contender were compared;
performance is not claimed universally dominant. This finding does not establish
an optimal word list, human discrimination threshold, or a portable event-ordering
contract for future Firefox releases.

Human outcome qualification and literal universal optimality: unestablished.
The broader behavioral SOTA acceptance remains provisional; the
[human study protocol](naming-human-evaluation.md) is a plan, not evidence.
The feature is delivered as a usable, verified implementation of the supplied
design, without presenting those unmet broader claims as completed work.
