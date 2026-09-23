# Human outcome qualification: fixed protocol, not completed evidence

The engineering feature implements the user's [design](Pro.md). It does not
establish that these words, templates, similarity thresholds or 64-name horizon
improve human recall or group identification. No participant study was run. The
pack's review is AI editorial review, not a human panel or population familiarity
norm. Use the following downstream rubric without changing it to certify a
preferred implementation.

## Task and fixed outcomes

Participants organize realistic, synthetic browsing tasks into native groups,
then identify the group needed for a described task. Avoid collecting their real
browsing history. Include ordinary desktop search/copy access and a separate
unaided condition; neither can stand in for the other. Tab-group identity is the
oracle, not spelling a remembered alias.

Primary outcome: wrong-group selection rate per instructed task. Keep successful
retrieval, failure to select, completion time (including its upper tail), exact
phrase recall, component omissions/substitutions/recombinations, and transcription
errors separate. Preference and appropriateness are additional outcomes, never a
substitute for correct target selection. Analyze the unit of independence as the
participant and account for variation across both participants and names.

## Comparators and assignment

Retain the original no-generated-title extension as the product baseline. Include
an independent adjective × noun generator as the naming control, a curated-word
control, approved pairs without contextual allocation, and the delivered approved
pairs with contextual allocation. Use matched interfaces, task contents, exposure,
number of groups, color policy, search/copy access and total study budgets.

Separate targeted template comparisons: noun–noun versus adjective–noun,
alliterative versus unrestricted, familiar versus unusual coherent phrases, and
typed three-word names versus the explicit numeric exhaustion fallback. Report
both length-controlled and capacity-aware conditions where they cannot be matched
simultaneously. Do not force poor words into a condition merely to match length.

Use many randomly assigned names and tasks rather than a handful of attractive
examples. Include long lists, repeated components, phonetic/spelling/semantic
neighbors, recombination lures, recent closure/recreation, manual names, and
separate-window context. Track actual fallback frequency. Include the audience's
English proficiency, accents, keyboard/screen-reader needs and vision differences.
The shipped pack is English; do not silently generalize to other languages.

## Timing, analysis and stopping

Run an exploratory pilot only to estimate outcome variability, task difficulty,
feasible recruitment and the precision needed for a useful decision. Before a
confirmatory trial, agree the smallest worthwhile reduction in wrong-target
errors and acceptable limits on task time/other protected outcomes with the
product owner; the implementation does not invent those tradeoff weights.
Determine sample size from pilot estimates and that precision target. Freeze
allocation policy, word pack, task rubric, multiple-comparison treatment and
stopping rule before confirmation. Preserve the original and direct controls.

Use independent immediate and delayed cohorts (about 24–48 hours, plus a longer
interval if the product use calls for one), or explicitly model the practice
introduced by repeated testing. Keep selection/exploration data separate from
fresh confirmation, including held-out name combinations. Report intervals and
unresolved differences; absence of significance is not equivalence. Any selected
policy or word-pack change needs a fresh confirmation for affected human claims.

## Acceptance status

This protocol supplies a reviewable next experiment. It supplies no measurements,
participant consent, recruitment authorization or evidence of behavioral
superiority. Universal optimality is unestablished. The human portion of a broad
“SOTA naming” claim remains provisional until appropriate trials support it.
