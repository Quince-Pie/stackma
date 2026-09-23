# Context-aware generated group names (1.1.0)

## Contract and selection rule, recorded before implementation

Authority: the user's naming request and `/home/quince/Downloads/Pro.md`; existing
pin/window/source boundaries and preference for lower state and bounded work still
apply. New Stackma-created groups receive one generated native title. Joining or
reusing a native group never grants permission to rename it. Existing, restored,
and manually named groups remain authoritative. Firefox still selects colors.

The lexical contract is a versioned, explicitly approved adjective–noun edge set,
not an arbitrary Cartesian product. Canonical labels use lowercase ASCII words
and one hyphen. Complete labels, literal component search, explicit selection,
and copying are part of the delivered interface. Names are non-secret aliases;
native group identity, not a label, determines the target.

Selection first satisfies membership, ownership, privacy and bounded-completion
constraints. Next it honors the user's lower-state priority. Work per assignment,
first use, context reads, temporary/retained memory, assignment latency and group
creation throughput remain separate objectives; there is no weighted score.
Human recall, wrong-target selection, retrieval time and spelling are distinct
human outcomes, not inferred from JavaScript timing or a combined word score.

## Scope and implementation premises

Context is all accessible open groups of the same private/normal class across
windows plus the last 64 generated aliases in that class. This is a bounded
engineering definition of “recent”, not a measured human-memory threshold.
Normal recent history lasts for the extension/browser session. Private entries
are removed when their originating window closes. No arbitrary manual title is
stored. `storage.session` survives event-page suspension, but not whole add-on
reload or browser restart. Native titles themselves persist through Firefox
session restore. No permanent group-ID-to-alias database is needed.

Hard lexical filters reject exact normalized duplicates and two-component near
neighbors. Near means the reviewed catalog's spelling/pronunciation/semantic
links (both slots), plus edit distance at most one for unknown manual tokens.
Arbitrary-language semantics, all accents, homoglyphs, and human confusion are
not exhaustively recognized. Similarity thresholds are conservative engineering
heuristics awaiting human evaluation. Context names are normalized with NFKC,
lowercasing, and whitespace/underscore/dash normalization only for comparison;
Firefox titles are never normalized or rewritten.

Component reuse is a soft preference: among hard-eligible pairs, minimize the
maximum of the two exact/variant component occurrence counts, then their sum.
This discourages concentration and recombination without falsely treating reuse
as forbidden. These are workload counts, not a memorability score. Select an
approximately uniform approved EDGE in that best tier, preserving unequal row
cardinalities. A bounded 64-bit multiply-and-scale draw has bucket probability
error below 2^-64 under uniform random input. No random retry loop is needed.

If the reviewed pair set is exhausted, choose the smallest unoccupied positive
`stack-N` label in at most occupied-count + 1 checks. This is an explicit,
copy-oriented numeric fallback, not a claim of mnemonic distinction. The popup
explains it and supports native manual renaming. Lexical/confusion filters are
never silently relaxed to manufacture another pair.

## Ownership and concurrency

Only a successful new-group creation schedules naming. Per-window membership
work continues independently of the serialized naming lane for each privacy
class. Naming failures cannot re-enter membership retries. A live event promise
and `idle()` include naming completion; this is not a durable transaction.

Each naming job takes fresh native context, chooses/reserves a label in its
privacy lane, records bounded session history, and writes only `{title}`. A final
native read and cancellation on observed title changes/removal/movement protect
manual work already visible to the extension. Color/collapse-only events do not
cancel naming. Manual edits after assignment are never repaired or reversed.

Firefox 156 has neither create-with-title nor compare-and-swap title update.
An external edit after the last read can still race; external rename/restore can
also introduce a duplicate. This extends the already accepted public API boundary
to metadata, and is not a global uniqueness/linearizability claim. A crash between
native creation and naming may leave an unnamed group; startup does not adopt
unowned unnamed groups. The supplied newer 158 source retains this limitation.

## Qualification and finite budget

Budget: 110 elapsed minutes from 2026-09-23 20:29 UTC, including source work,
delegation, implementation, experiments and verification; deadline 22:19 UTC.
The recoverable pre-feature source/package is `artifacts/naming-baseline/`;
pre-feature evidence is `evidence/v1.0.1/`. Reference source trees stay untouched.

Compare independent dictionaries (conventional control), approved flat-edge
filter arrays, two-pass count/select, reservoir selection, bounded rejection with
full-scan fallback, cached decks and precomputed conflict indices. Reject only
through contract mismatch, applicable bounds or matched measurements. Runtime
Markov/neural generation cannot replace explicit reviewed pair membership.
Human-id, unique-names-generator, petname, coolname and MASCARA primary source
mechanisms are recorded in the final qualification record with pinned versions.

Before confirmation: compare contract-matching selectors on the same compiled
catalog/context and resource boundary. Include empty, typical labelled-scenario,
large, and exhausted contexts, initialization and complete allocation. Use a fixed
warm-up followed by 12 randomized-order blocks; report medians, ranges and tails
without a universal dominance or statistical equivalence claim. The user's
state priority resolves a real scan/temporary-array tradeoff unless end-to-end
work exposes an unacceptable cost. These scenarios have no invented user weights.

Required checks: catalog integrity/reproducibility; independently justified
selector and lifecycle oracles; grouping regressions; actual Firefox 156 naming,
manual metadata, privacy, lifecycle and UI checks; strict typecheck, extension
lint, packaged-source integrity and reproducible build. A fixed downstream human
trial protocol will be supplied. Human-performance superiority remains
unestablished without representative controlled trials; engineering acceptance
must not be described as a completed human-memorability qualification.

## Native identity correction discovered during verification

The original implementation premise that native group IDs identify one object
was disproved in Firefox 156. `addTabGroup` uses a timestamp plus one of 101 random
suffixes without checking for a collision. A deterministic disposable-browser
fixture fixes only the clock, creates 102 native groups, restores the clock in
`finally`, and verifies that lookup/update can address the first of two distinct
groups sharing an ID. This is not an estimate of natural collision frequency.

The delivered safety response is to preserve ambiguous groups and report the
failure. Naming checks the complete query before writing; a second creation
reusing a pending ID cancels authority. Popup Open is disabled for observed
ambiguity and rechecks before activation. Grouping validates participating IDs
before trusting native membership or using an ID-based mutation.

A small shared guard retains only ambiguous IDs (normally none), never group
names or a full native group index. Creation/removal/movement/window events
invalidate it. Fresh naming queries also populate it, so a normal subsequent
join does not need another native query. Validation after fresh endpoint reads
uses the target Firefox's event/reply ordering; the exact mechanism and accepted
post-read race are documented in the qualification record. This correction is a
safety feasibility requirement, so the additional work takes precedence over the
older grouping performance comparison. No workaround can make a public native
ID update distinguish two objects that share that ID.
