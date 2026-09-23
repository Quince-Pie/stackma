# Group property review

Scope: Firefox 156 native group identity, title, color, collapse and ownership;
preserve the established grouping, pin, window, manual-edit and source-signal rules.
This is a new, bounded review requested after the initial implementation. Budget:
50 elapsed minutes from 2026-09-23 17:19 UTC, including source investigation,
independent review, implementation, verification and delivery.

Baseline: kernel SHA-256
`fd3458b8c2c632f77a7f311d90f75c399ca1831cc509b396e7904f03fcbaeaf6`;
XPI `d2fa23356d0cc54aa4f687706a0dfd86b2aee17422d1ce0664bda067ce32f508`.
Recoverable source/package copies are in `artifacts/metadata-review-baseline/`.
The supplied reference repositories and the pre-existing staged work are preserved.

## Contract and selection before implementation

Group properties belong to the user and Firefox. Existing opener groups retain
precedence. New groups use native defaults unless the user requests automatic
naming. Metadata reads/writes must not be added to every creation or wakeup.
The previously selected lower-state, bounded-work priority remains in force.
Correct grouping and preserving unrelated group members are feasibility constraints.

The user confirmed: **keep native defaults; preserve manual names and colors**.
No automatic naming, extra title access or metadata-writing permission is added.

The bug under investigation is a late incoming relation A→B after B→C has already
formed a group: with ungrouped A, the baseline recreates [A,B,C], losing B's existing
group identity and metadata. This is different from deliberately merging into an
already-grouped opener, where the opener's group must win.

Selection criteria: retain an existing native group when its entire membership is
part of the accepted branch (including inseparable split companions); preserve
manual metadata without copying stale values; minimize extra retained state,
API records and native moves. Keep native tab ordering rules and the relative
order of uninvolved tabs. Reusing a group may move the opener to that group's
position. When several exclusive child groups must merge, the first eligible
one in the existing event order supplies the surviving identity; preserving
multiple different IDs/colors/titles in a single native group is impossible.

## Applicable alternatives

| Design | Decisive mechanism and disposition |
| --- | --- |
| Recreate every late branch (baseline) | Meets membership but loses existing identity/title/color/collapse state when the previous group empties. Must be corrected where preservation is feasible. |
| Copy title/color/collapse after creating | Needs tabGroups permission, additional read/write calls, cannot preserve ID or unexposed native state, and can overwrite intervening edits. Retaining the actual group removes these problems. |
| Reuse any child group | Can add the source to unrelated members of that group. Violates the established ownership boundary. |
| Query every member, then reuse an exclusive group | Feasible control. Firefox enumerates the window for this filter and returns every member, including unowned ones. |
| Prove exclusivity using indices | Native group members are adjacent. A complete contiguous interval of known branch members, with neither adjacent tab in the same group, proves exclusivity under the accepted read/commit boundary. Indexed tabs.query is specialized in Firefox 156. Partial split units require checking their immediate neighbors too. No persistent cache or metadata permission. |
| Cache all group membership/properties | Adds startup coverage, update/move/removal bookkeeping and stale-state handling; does not improve the chosen state/work objective for this exceptional path. |

No statistically superior latency claim is required to decide identity preservation.
Verification uses fixed metadata/membership oracles, authoritative native behavior,
deterministic operation counts and a matched browser comparison of the affected
path. Timing observations are descriptive, with setup/cleanup scope explicit.
Historical v1.0.0 measurements remain evidence for that revision; they are not
silently relabeled as measurements of a changed artifact.

## Source findings

Authority: supplied MDN at `8530cf97b809705c3524e733afcb69124b305b2e` and Firefox
156.0 release `3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1`.

| Property | Firefox 156 behavior and Stackma policy |
| --- | --- |
| Title | `Tabbrowser.addTabGroup` defaults `label` to the empty string. This is the real API title; localized “Unnamed Group” is an accessibility/tooltip fallback, not a saved name. Stackma does not read page titles or invent names. |
| Color | `tabgroup-menu.js` nextUnusedColor scans open groups across windows of the same privacy class. Palette order: blue, purple, cyan, orange, yellow, pink, green, gray, red. First unused wins; after exhaustion Firefox chooses randomly. No uniqueness guarantee beyond available colors. Public tabGroups APIs spell gray as `grey`. |
| Collapsed | New groups start expanded. API group/move of existing tabs does not rewrite this flag, but native new-tab insertion expands an inherited collapsed group before the extension event. The extension preserves these native semantics. |
| ID and window | Retained group identity remains intact during the fix; IDs are browser-owned and not promised stable across restore. Cross-window relationships stay excluded. |
| Unexposed state | Retaining the native object also preserves saveOnWindowClose and other native state that cannot be faithfully reconstructed through tabGroups.update. Native activity/recency and membership still update normally. |
| Optional API fields | Firefox 156 exposes title, color, collapsed, id and windowId. Shared/saved/sync fields are not configurable through its tabGroups schema. No extra permission or metadata mirror was added. |

Implementation paths: `browser/components/tabbrowser/Tabbrowser.sys.mjs`
addTabGroup, moveTabToExistingGroup and insertion; `content/tabgroup.js` label/name,
collapse and addTabs; `content/tabgroup-menu.js` nextUnusedColor;
`browser/components/extensions/parent/ext-tabGroups.js` convert/update;
`toolkit/components/extensions/parent/ext-tabs-base.js` indexed query specialization;
`browser/components/sessionstore/TabGroupState.sys.mjs` collect.

The supplied 158.0a1 snapshot retains the affected behavior (tabgroup moved from
.js to .mjs). No newer metadata transaction or replacement API was found there.
Maintained alternatives inspected include Lineage Tab Groups `b62e946`, Smart Tab
Group `22d8099`, Tabius `3ddabd7`, and Tree Style Tab `7d0b326`: respectively native
colors with title initialization; stored title/hostname policy; explicit domain
rules; and synchronized native/tree metadata. Their extra naming semantics are
not requested here. Preserving the native object satisfies the confirmed policy
without their additional metadata reads, writes or state.

## Delivered correction and proof scope

When the opener is ungrouped, consider grouped children in existing event order.
Reuse the first group whose complete membership is covered by the accepted branch
and its inseparable split companions. Known unique indices must form a contiguous
interval, and its adjacent indices must not belong to that group. Partial split
units are completed by reading only immediate neighbors. This proves exclusivity
under the same accepted external-state read/commit boundary; inconsistent index
snapshots are rejected. No group-wide enumeration or persistent cache is used.

The native join includes the opener and direct incoming children for validation.
Already-grouped descendants stay in place. Firefox's already-member early return
preserves their ordering. For the privacy workaround, the opener joins the retained
group first; child edges are accepted only after that succeeds. Remaining work uses
the established retained-plan retry path. A failed probe is retried once; persistent
failure is reported and releases the queue. Native user edits to title/color made
while membership is being checked survive because no property values are copied.

Ordinary ungrouped creation and existing-opener joins perform no added queries.
For a grouped branch, the proof uses at most two boundary results per candidate
plus at most two neighbor results per partial split unit, with duplicate positions
cached only for that operation. It visits already-known branch records. Indexed
queries avoid filtering all window tabs, although Firefox may rebuild its native
cached tab array; this is not a claim of constant whole-browser CPU time.

A full group query is a valid alternative but may return arbitrarily many unrelated
members just to reject reuse. It lacks the selected participant-based work bound.
Copying metadata cannot preserve identity or unexposed state and can overwrite a
new user edit. The old recreation path fails the required preservation oracle.
These correctness and resource arguments decide the metadata architecture; no
claim of universally lower latency or resident-memory dominance is made.

## Evidence and acceptance

The identical 8-case Firefox metadata oracle passed 4/8 cases on the archived
baseline, failing normal/private late-parent identity and split-companion cases.
The corrected version passes all 8. New model tests cover 13 cases: positions,
foreign members, source precedence, conflicting child groups, edits during waits,
private fallback, closure, retry and persistent failure. The model's indexed-query
filter and existing-member no-op behavior were repaired against Firefox source.
Two injected query failures initially affected the same concurrent attempt; the
persistent-failure test now rejects every probe rather than mislabeling a recoverable
failure. Its failure criterion did not change.

Current checks: 48 behavior tests, 74 alternative-design checks, 20 general Firefox
integration cases, and 8 metadata browser cases. Baseline/candidate metadata reports
are retained separately. The existing fixed 1,080-sample comparison is rerun for
the changed source and matching alternatives, covering ordinary creation/join paths.
It does not measure late-branch repair latency: that decision is supported by the
identity oracle and source-derived work bounds above. No statistical equivalence,
extreme-tail or universal-optimality claim is inferred.

Contract/property verification and scoped metadata qualification are satisfied under
the approved API boundary and native-default policy. Literal universal optimality
is not established. Current evidence is in `evidence/metadata-before.json`,
`evidence/metadata-tests.json`, `evidence/check.log`, and the
[versioned performance record](performance.md). The original accepted artifact and
its measurements remain recoverable; signing/publication is outside this task.

The v1.0.1 XPI is 7,066 bytes. Temporary installation, every packaged file's
digest, and real opener grouping passed. Two builds produced SHA-256
`e8e33dbc850d0a812abd0456874ad3bd3f4a77fda893025cb6ceda41693d68de`.
Fresh confirmation completed all 1,080 samples on the delivered kernel; no old
timings were substituted. Final verification completed at 18:08 UTC, within the
50-minute review budget. Neither reference repository was modified.
