# Qualification record

This is the original v1.0.0 qualification record. The subsequent
[v1.0.1 metadata review](metadata-review.md) found and fixed a late-parent group
replacement that lost metadata. Its findings supersede the blanket preservation
statement below. The original evidence is retained in `evidence/v1.0.0/`; current
verification and measurements describe v1.0.1. Historical results are not being
relabeled as verification of unchanged metadata behavior.

## Contract and decision scope (established before implementation)

Firefox desktop 156, native tab groups. A browser-reported new child joins its
opener's existing group; otherwise opener and child form a new group. Descendants
and simultaneous siblings obey the same rule. Unrelated tabs are left alone.
User decisions: preserve pinned tabs and window boundaries, so pinned endpoints
and relationships across windows are excluded. No inference from active tabs,
URLs, domains, titles, or browsing history. No retroactive reorganization on
installation. Firefox owns group persistence and manual edits after creation.

The user explicitly approved leaving tabs unchanged when Firefox supplies no
relationship, including inactive duplicates for which no source is exposed.
This is an information boundary: two distinct source histories can produce the
same extension events. Guessing by active tab, position or URL cannot recover
that missing fact. First valid creation signal for a child wins; subsequent
signals are deduplicated, including after manual ungrouping.

Hard constraints: Firefox 156 APIs; preserve pins, windows, private boundaries,
container identity, selection, and unrelated tabs; no external data collection.
Failure and concurrency semantics must be explicit, including events that cannot
be observed during disablement or a browser crash. No requirement for synchronous
grouping or a numerical latency/memory limit was supplied.

The user subsequently accepted the documented Firefox API boundary for concurrent
edits: checks are fresh observations, not an atomic conditional mutation. Pins
and window boundaries are preserved when they remain stable through the native
call; an external edit in the read/commit gap can race. This is an authorized
contract boundary, not an omitted permitted input or a claim of linearizability
against external actors. The user requested checking newer Firefox fixes.

Version audit: Firefox 156.0.1 and supplied HEAD 158.0a1 have byte-identical
`browser/components/extensions/parent/ext-tabs.js`, `ext-tabGroups.js`, and
their `schemas/tabs.json` / `schemas/tabGroups.json` relative to 156.0. The
conditional-operation gap and current-window privacy check remain. This says
nothing about later commits or future releases. Recheck those methods and
schemas before removing the workaround or strengthening the guarantee.

Selection: first satisfy the contract. Among feasible designs compare event-to-
group latency (including burst tail), API calls and tab records transferred,
steady/idle and burst memory, startup/teardown work, permissions, and reviewable
state invariants. No arbitrary weighted score or equivalence margin. A material
unresolved tradeoff is not evidence of dominance. Scenarios: one link, sibling
bursts, descendant chains, many idle tabs, independent windows, manual interference,
event-page sleep/wake, closure and API rejection. These are labeled coverage
scenarios, not an invented user frequency distribution.

After seeing the three-run exploratory tradeoff, the user selected **lower state
and bounded per-window work** over latency for independent families. This resolves
the architectural Pareto choice; it does not establish universal dominance.
The chosen read strategy bounds ordinary in-flight tab snapshots to 33 per window
(32 children plus their source), independent of total open-tab count. Larger
ancestry repairs read in chunks and necessarily visit their affected branches.

## Confirmation protocol (fixed before confirmation)

Six controls/candidates: serialized FIFO (batch 1); delivered sibling batching
(32); wider batching (128); fresh window queries; queries only for read phases
with at least 16 requests; dependency/component scheduling with shared/exclusive
window gates. Same grouping kernel semantics, native resources, retry policy and
membership oracle. No latency differences excuse a correctness failure.

Fresh headless Firefox 156 profile; Node24/locked tooling; only the test extension;
external network blocked in that disposable profile to prevent system-policy
add-ons contaminating results. Standard normal windows with 2, 33, 40 and 512
tabs. Scenarios cover single children, 32/128 siblings, 32-deep chains, and 16
independent roots. Both admission of existing tabs and real tabs.create through
production-shaped event listeners are timed. Actual tab-creation costs are inside
the latter timer. Setup and cleanup are separately retained, never called free.

Twelve measured blocks per scenario after two warm-up blocks. Variant order
rotates and reverses within blocks to reduce drift/order bias. Fixed stopping
rule: complete all blocks, with no optional significance peeking or reruns to
obtain favorable samples. Failed validation invalidates that run. Report every
scenario separately: median, observed range, API counts, and transferred tab
record counts. Conversion/message counts are source-derived and measured by
constant-cost counters; no JSON serialization is added to timed operations.

Uncertainty treatment: these are descriptive, paired, same-session measurements.
Samples share a browser/process and are not asserted independent; no p-values,
practical-equivalence claims or statistical dominance are inferred. Twelve
samples cannot establish p99 latency. Observed maxima remain visible, and noisy
or overlapping differences are unresolved. There is no invented nonregression
tolerance or weighted workload average. The selection priority above, proven
resource bounds and confirmed behavior decide the tradeoff; performance figures
describe its cost. API completion does not include completed paint or completion
of Firefox's asynchronous session-state flush. Native mutation and first-use
costs are analyzed separately below; no full-system optimality claim is made.

Research budget: 100 minutes total from 2026-09-23 15:18 UTC, including independent
source reviews, implementation, experiments and verification. Approximately 20
minutes source qualification, 40 implementation, 25 verification/comparison, 15
review and delivery; work can move between allocations within the total.

## Original state and authority

No root commit or extension existed. `.gitignore` was staged; `flake.nix` was an
existing Python scaffold marked intent-to-add. Neither reference repo is modified.
The original flake is preserved in `evidence/original-flake.nix.txt` (SHA-256
2442d6780a12b86303cc5fc5d2f1bd1a34f428dd34e650e14cc4e14f65b278e0).

Supplied Firefox checkout: 9e9b5f17f56187c1f5c8b9cdf79a01ff51a7b643 (158.0a1).
Target authority: local `FIREFOX_156_0_RELEASE`,
3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1. Installed browser reports 156.0.
Supplied MDN: 8530cf97b809705c3524e733afcb69124b305b2e. Target source and runtime
take precedence over examples or version-generic advice where they differ.

The Vivaldi requirement is [As Tab Stack with Related Tab](https://help.vivaldi.com/desktop/tabs/tab-stacks/).
MDN paths are relative to `content/files/en-us/mozilla/add-ons/webextensions/`.
Firefox paths below refer to the target tag, read with `git -C firefox show`.

## Sources and mechanism qualification

The reference trees were inspected selectively along the complete affected paths;
loading unrelated compiler/rendering code would not improve this extension's
contract. These are primary sources, not inherited model-cutoff assumptions.
Firefox references below name symbols in the exact target revision above.

| Required mechanism | Primary evidence and implementation consequence |
| --- | --- |
| Link causality | `ext-browser.js` Tab.openerTabId; `URILoadingHelper.sys.mjs` navigation-target notifications; `nsWindowWatcher.cpp` new-window notification; `ext-webNavigation.js` sourceTabBrowser conversion. Register both creation APIs, never infer from activation. |
| Existing native inheritance | `Tabbrowser.sys.mjs` addTab passes openerTab.group into insertion; lastRelatedTab can supply a different group when the opener is ungrouped. Read both endpoints and skip only equal nonnegative groups. |
| Group creation and ownership | `ext-tabs.js` group; `getNativeTabsOrSplitViews`; `Tabbrowser.addTabGroup`; `tabgroup.js` addTabs. Create with explicit windowId; preserve native group metadata; split views move as units. |
| Privacy bug and safe fallback | `ext-tabs.js` group performs current-window privacy validation first; `Tabbrowser.getTabGroupById` searches same-privacy windows. `moveTabTo` inserts at a member DOM node. Use documented group arguments, then same-window move on the precise privacy error. Never combine groupId with createProperties: schema/MDN explicitly prohibit it despite runtime acceptance. |
| Event-page lifetime | `ExtensionChild.recvRunListener`, `ExtensionParent` pendingRunListenerPromises/API idle reset, `ext-backgroundPage.terminateBackground`. Register synchronously and return processing promises. Forced sleep/wake was exercised; pending promises delay suspension once, not indefinitely. |
| Restoration | `SessionStore.sys.mjs`, `TabStateFlusher.sys.mjs`, `Tabbrowser` restore creation, and Firefox's `browser_tab_groups_restore_simple.js`. Firefox owns persistence; do not save runtime IDs or scan/reorganize old tabs on extension startup. |
| API/version support | Target schemas plus supplied MDN `api/tabs/{tab,group,move,oncreated}`, `api/webnavigation/oncreatednavigationtarget`, `manifest.json/{background,browser_specific_settings}`. MV3 module event page; no service worker or compatibility polyfill. The current typings omit navigation windowId, so its small local type assertion follows the inspected 156 event conversion. |

Source root: [Firefox 156 release](https://github.com/mozilla-firefox/firefox/tree/3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1).
MDN root: [supplied content revision](https://github.com/mdn/content/tree/8530cf97b809705c3524e733afcb69124b305b2e/files/en-us/mozilla/add-ons/webextensions).

Current implementation search included opener/lineage mechanisms, native group
inheritance, source-less navigation, tree representations, polling, batching and
dependency scheduling. There is no classification/AI research problem here:
the required relation is supplied by the browser, not estimated from content.

| Contender actually inspected | Mechanism, decisive challenge and disposition |
| --- | --- |
| [Lineage Tab Groups 1.0.0](https://github.com/pagdot/firefox-addon-lineage-tabgroups/blob/b62e946a73bd3bfd5b18e7cafcc06dea5d84f2f4/background.js) | Exact opener/native groups; independent handlers race when siblings both read an ungrouped opener. It also omits creation windowId. The model reproduces the two-read/two-create split. Not adopted unmodified. |
| [Smart Tab Groups 1.3.2](https://github.com/mong8se/smart-tab-group/blob/22d809906e8e509b457a56b5dd06be3d07ee1e00/src/smart-group.js) and [Tabius 2.0.5](https://github.com/FaisalBinAhmed/tabius/blob/3ddabd7ed2f981ca43c15d2e1673167fa9013dc3/src/background/background.ts) | Opener grouping without the needed intersecting-operation serialization. The same adversarial sibling execution applies. Their extra rules/storage/naming do not resolve it. |
| [New Tab Same Group 1.7.0](https://github.com/onlybets/firefox-addon-new-tab-same-group/blob/f1f04a71951b648da747d169416dd08ff796b659/background.js) | Active-tab history and five-second polling use a different relationship oracle and do not create a group around an ungrouped opener. Contract mismatch. |
| [Tree Style Tab](https://github.com/piroor/treestyletab/tree/7d0b32622ec412eb8a679aad76f4dd68cf273ccd) | Current source supports native groups; it was not dismissed as sidebar-only. Its ordinary opener path attaches an internal tree; native-group machinery also handles separate tree/group state. The relevant graph/scheduling advantage is represented by the implemented dependency challenger, without importing unrelated sidebar behavior. |
| Conventional per-window FIFO | Correct control after adding the same lifecycle, ancestry and failure mechanisms. Batch size 1. Tested and measured under matched semantics. |
| onCreated-only simplification | Ordinary clicks, noreferrer and window.open usually already expose openerTabId in Firefox 156. That does not cover the full accepted signal contract: a real `URILoadingHelper.openLinkIn` call with frameID and relatedToCurrent:false emits a same-window navigation source but no Tab opener. The `navigation-source-without-tab-opener` browser test exercises that native path, asserts onCreated's opener is absent, and verifies grouping. No extension events are fabricated. Keeping the second source signal therefore covers a permitted native/API input; it is not justified by incorrectly equating DOM noopener with a missing Tab opener. |
| Sibling batching, 32 and 128 | Coalesce only consecutive siblings without a timer; parallel fresh reads, one group call. Same ownership/ancestry policy. Wider batches trade more live snapshots for fewer calls on large bursts. Both measured, including 128 siblings. |
| Fresh window query, always or threshold 16 | Implemented derived kernel, tested, measured also with windows containing only the participants. It reduces messages but converts/retains N tab records and enumerates N native tabs. Selected pair reads provide a cardinality bound independent of N. |
| Dependency/component scheduler | Implemented and tested, including global identity across window moves, late unions, writer exclusion, split units and private fallback. It can reduce independent-family waiting. It adds endpoint/component sets, union relabeling, gate/escalation states and overlapping API work. Rejected for delivery under the user's explicit state/work priority, not as incorrect or universally slower. |
| Full tab-state cache / reconciliation | A cache adds initial coverage/invalidation, subscriptions and state for unrelated tabs. Fresh native checks remain necessary for the established processing-time eligibility policy; a cached event can lag a manual change. Polling alone cannot distinguish a missed relation from intentional ungrouping. Full-window or cached-state strategies also lack the selected participant-count work bound. |
| Content-script-only detection | Cannot cover privileged/restricted pages and browser-originated opens; adds per-document execution and host access. Browser relationship events cover the needed signals without page injection. |

Comparators remain in `experiments/`, outside the package. Each received the same
ownership fixes, bounded retry semantics and completed-promise release. The
dependency prototype passed the production model suite plus its own scheduling
cases and the real-browser suite; it is a substantive challenger, not a strawman.

## Invariants, failure and progress

Each live recorded child has at most one incoming creation relation. A nonnegative
recorded group means that incoming edge was actually accepted: creating a source's
own child must not accept an unvalidated incoming edge. Observing a source outside
its assigned group disowns the old edge. Confirmed descendants are traversed only
while their current window, pin and group state still match that branch. These
rules prevent both late-parent stranding and pulling manually reassigned tabs.

One queue owns ordinary mutations per window. Consecutive siblings share a batch;
chains remain ordered. Separate windows have independent queues. Late parent
events expand only the already accepted, still-connected descendant branch. This
does not merge arbitrary other members of the child's native group. Existing
native group identity/name/color/collapse state are preserved by our calls;
Firefox's own activation/visibility rules still apply. New groups and insertion
use native order/adjacency rules; unrelated tabs retain their relative order.

All tab IDs come from the browser and are validated before enqueue. IDs are
session-local and never persisted. API results are fresh snapshots, not mutable
aliases. JavaScript handles alignment/allocation/reclamation; there are no unsafe
memory operations, custom counters, fixed-width ID truncations, content callbacks
or shared-memory threads. Browser ID uniqueness avoids reuse/ABA within a session.

Known missing/inaccessible endpoints cancel work. Pin/window mismatches cancel
that relationship. Failed ordinary mutations get one fresh-read retry. Privacy
fallback retains its expanded plan, retries each target once, and records progress
immediately: moving a split-view member can implicitly move an ancestor, so a
whole-batch retry could otherwise skip unfinished descendants. Persistent partial
failure is reported once, without claiming completion, and later jobs continue.
The background owns policy: local console details and a dismissible toolbar notice.

FIFO ordering and native synchronous validation/mutation prevent our own competing
group creation. The grouping postcondition is established at the successful native
operation while the accepted external-state boundary holds. The multi-call overall
operation is not advertised as linearizable against external pin/move/regroup
operations. No lock-free/wait-free claim is made. For finite arrivals and settling
API calls while the page remains alive, queued work completes or reports/cancels;
an indefinitely stalled browser API can stall that window. There is no retry timer,
busy loop, polling, or arbitrary dropped-event quota.

Completed jobs release their individual promise/resolver objects; a shared settled
promise serves duplicate signals. `onRemoved` releases relation links. Event-page
unload releases all transient extension state. Native groups are retained on
disable/uninstall, and ordinary Firefox restore owns their persistence. Crash or
disablement can lose an in-flight event; no crash journal or replay guarantee is
claimed. Startup is not retroactive, and events before listener registration cannot
be reconstructed reliably from tab positions or URLs.

## Cost and lifecycle model

For a fresh ordinary batch of b siblings, b <= 32, read b+1 tab records concurrently
and perform at most one group mutation. The already-satisfied path performs no
mutation. FIFO reads 2b records and can perform b mutations. A late-ancestry repair
necessarily visits its still-linked affected descendants, in bounded read chunks;
its mutation can include the expanded branch. Private fallback additionally reads
each endpoint and moves individual native units. These exceptional costs are
included rather than hidden behind the fast-path bound.

Transient extension state is O(live recorded relations + queued work + affected
branch). Queue head compaction avoids quadratic shifting and bounds stale prefix
slots to an amortized constant. No initialization scan, stored tab cache, disk
writes, idle timer, host permission or runtime library is used. The native parent
process may retain API wrappers independently of the event page.

`tabs.get` uses tab-ID Map lookup plus one conversion. A window query enumerates
and converts all N matching native tabs, returning N records and an array. Cached
frame dimensions and stored tab indexes do not require a fresh layout flush just
to read them. The comparison therefore concerns messages, conversion/allocation
and data movement, not an invented per-get reflow penalty.

Native grouping is not constant-time: tab/split-unit movement invalidates caches,
reindexes the window, emits notifications and updates group accessibility state.
Flattening groups can shift array suffixes; do not infer a universal linear native
bound. New groups also choose a color and request asynchronous state flushes.
Avoiding redundant native mutation matters beyond the JavaScript queue itself.
API completion is a useful observable boundary but not completed paint or durable
disk persistence; the performance record makes no claim about those tails.

## Verification and acceptance

Tooling is deliberately small: a locked Nixpkgs input, plain `genAttrs` Linux
development shells, Node 24 LTS, geckodriver, zip and nixfmt. No flake framework,
automatic package updates or environment mutation hook is required. Firefox is
the installed target binary, with a strict major-version assertion in the harness;
updating development tools cannot silently change the tested target. npm versions
and integrity hashes are locked. Strict TypeScript checks plain ES modules; Mozilla
web-ext validates the Firefox manifest/package. The aarch64-linux shell is defined
and evaluated, but runtime tests are on x86_64-linux. No cross-platform timing claim
is made. This routine shell setup does not need an unrelated benchmark study.

The final commands, source hashes, numerical comparisons and result summaries are
linked in [performance evidence](performance.md) and `evidence/`. Model tests use
immutable snapshots, controllable API boundaries and a separate connected-component
oracle. They cover queue races, late ancestry, manual edits, cancellation, partial
failure, structured errors, cleanup, and the upstream unqueued counterexample.
Native tests cover real links, noreferrer, iframes, window.open, window boundaries,
pins, containers, split units, group metadata, restoration, and sleeping-background
wakeup. They run on the actual installed Firefox 156, with disposable profiles.

An ancestry-ownership defect found during final review invalidated the first
confirmation run. It is retained as `artifacts/benchmark-before-ancestry-fix.json`
for diagnosis and is not acceptance evidence. The corrected source and all
comparators are rerun without changing the membership oracle or selection rule.
Earlier harness repairs (navigation readiness, current moz-src module paths, and
test-model query support) likewise do not convert failed checks into passes.

Final results:

- **Contract and verification satisfied** within the user-approved pin/window,
  external-edit and reported-source boundaries. 35 behavior tests pass; 60
  alternative-design tests pass (including the shared behavior suite); all 20
  final Firefox 156 integration cases pass. Type checking and Mozilla lint report
  no errors/warnings. Both Linux flake outputs evaluate successfully; nixfmt passes.
- **Frontier qualification achieved for the declared scope and selection rule.**
  The six measured implementations pass all 1,080 fresh confirmation samples.
  The source-only native case rejects the otherwise attractive one-event shortcut.
  Dependency scheduling and larger batches remain valid performance choices;
  the user's explicit state/work priority selects the delivered design. Detailed
  ranges and record counts are retained, including challenger-favorable cases.
- **Literal universal optimality is not established or claimed.** In particular,
  the delivered choice is not the latency winner on every workload, and there is
  no measured resident-memory or extreme-tail dominance claim. This is a scoped,
  evidence-backed engineering qualification, not a proof against all programs.

The unsigned XPI is 5,965 bytes and was installed successfully as a temporary
add-on in Firefox 156. Every archived source file was hashed against its original,
and a real opener/child pair grouped successfully. Two builds produced the same
SHA-256: `d2fa23356d0cc54aa4f687706a0dfd86b2aee17422d1ce0664bda067ce32f508`.
Package evidence is in `evidence/package.json`. Mozilla signing/publication was
not requested or performed. The original staged `.gitignore` content remains
staged as before; task additions are separate working-tree changes, and both
reference repositories remain unmodified.

Final checks completed on 2026-09-23 at 16:56 UTC, about 98 minutes after the
recorded start, within the 100-minute elapsed budget. Investigation, delegated
reviews/prototypes, repairs, invalidated comparisons and final verification all
occurred within that window; none renewed the budget.
