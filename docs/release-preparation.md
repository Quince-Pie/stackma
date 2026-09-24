# Release preparation qualification

This is the original preparation design record. The
[policy review and corrections](release-policy-review.md) supersede its workflow
display names and its mistaken 65535 version-component limit. Current operator
instructions are in [Releasing Stackma](releases.md).

Reviewed 2026-09-24 against `538841aaab029d984e31e469ebf42fc275322460`.
The original manual publication command required a version update and a pushed
tag. Entering `v1.1.1` failed because that tag did not exist; all four version
fields were still `1.1.0`. Fetching more tags could not fix that missing step.
The user selected **explicit version → release PR → merge → release**. This
supersedes manual preparation while preserving manual existing-tag recovery.

## Scope and selection

Scope: this single Firefox extension, stable canonical `vMAJOR.MINOR.PATCH`
versions with components at most 65535, GitHub.com, reviewed merges into `main`,
the locked Node 24/Git toolchain, and the existing listed-AMO publication pipeline.
Feasibility requires synchronized versions, unchanged dependency/identity data,
release of the verified merged source, no automatic merges/protection bypass,
no overwriting conflicting refs/PRs, and recoverable interrupted preparation.
No extension behavior or licensing change is included.

Selection criteria were recorded before implementation in
`artifacts/release-interface/scope.json`: retain correctness and publication
protections, then reduce operator steps, credential scope, mutable workflow state,
and duplicate verification. This is an occasional administrative operation. No
representative release rate, latency target, workload weighting, performance
dominance, or universal optimality is asserted. The user resolved the consequential
PR-versus-direct-main choice; version inference remains unrequested.

A finite **50-minute** total budget started at **03:07:25 UTC**, covering source
inspection, implementation, fault tests, review, and documentation. Source
snapshots and exploratory output are under `artifacts/release-interface/`;
[verification evidence](../evidence/release/preparation.json) records the delivered
file hashes, completed commands, and elapsed budget. The existing untracked
`extension/icon.png` and ignored environment credentials were preserved.

## Alternatives and current source coverage

| Mechanism | Applicability, decisive costs, and selection |
| --- | --- |
| Manual version edits, tag, dispatch | Conventional control. Works with correct prerequisites, but caused the reported failure and leaves four synchronized fields plus tag creation to the operator. Superseded for new releases; retained for existing-tag recovery. |
| Direct version commit/push from dispatch | Could remove a merge step but needs direct-main update policy and race handling against concurrent main changes. The user explicitly chose a reviewed PR. |
| Release Please action **5.0.0** / library **17.11.2** | Maintained release-PR family; Node 24 in action v5, explicit `release-as` and JSON extra-file updates exist. However, the inspected `buildReleasePullRequest` still skips empty/non-user-facing conventional changelogs even with an explicit version. Stackma uses subsystem commit subjects, with no authorized conventional-commit/changelog policy. A customized strategy and separate AMO publisher could work, but adds a second release manifest/history policy without removing our required guards. Not selected for this explicit-version contract. |
| Changesets action **2.1.2** | Modern Node 24 subactions separate versioning from publishing and default to API-created commits. It requires Changesets CLI v3, changeset/package state, and a Firefox-manifest hook. `runVersion` recreates its version branch, and `pushChanges` uses `force: true`. A custom version script and recovery guard would still be needed. Not selected for one manually versioned extension. |
| `create-pull-request` **8.1.1** | Strong general PR challenger. v8 uses Node 24; 8.1.1 repairs post-creation 422 consistency retries. Its normal branch reconciliation resets changed branches; Git pushes use force-with-lease and API signing uses `updateRef(force: true)`. Those intentional update semantics conflict with preserving observed edits to an existing release PR. Wrapping it would retain our identity/recovery machinery around another branch updater. |
| `release-it` **21.1.0** | Strong explicit-version CLI control. The current changelog includes the semver-to-verkit migration and coercion corrections. Its version strategy accepts/coerces broader SemVer inputs, and its Git lifecycle stages/commits/tags/pushes with rollback. PR creation, Firefox constraints, and conflict-preserving recovery still require a coordinator. It is useful for a different operator flow. |
| GraphQL `createCommitOnBranch` with `expectedHeadOid` | Credible native alternative with atomic head comparison and automatic GitHub signing where supported. It needs an existing branch, so preparation exposes an intermediate branch without the version update and must recover that phase. It saves one creation request. The selected REST path publishes a branch only after its complete tree and commit have been validated, retaining one create-only ref policy. No latency superiority is claimed. |
| Native Git tree calculation plus GitHub REST creation | Selected. The isolated index proves the complete intended tree; inline tree contents avoid separate blob uploads. A finished commit is attached with create-if-absent. Recovery checks exact parent, tree, message and PR identity; no general branch-reconciliation engine or extra runtime dependency is needed. The project owns this small coordinator and its tests. |

Source identities and decisive paths:

- [Release Please action v5 changelog](https://github.com/googleapis/release-please-action/releases/tag/v5.0.0),
  commit `45996ed1f6d02564a971a2fa1b5860e934307cf7` (bundles library 17.6.0).
  The newer library's
  [17.11.2 strategy](https://github.com/googleapis/release-please/blob/05c6a4f71022304d4edad24ea90c1c16324503d5/src/strategies/base.ts)
  and manifest/extra-file handling were inspected, including early exits, explicit
  version selection, changelog eligibility, and skip-GitHub-release behavior.
- [Changesets 2.1.2 changelog](https://github.com/changesets/action/releases/tag/v2.1.2),
  commit `ae32849d5ba541f9ae29e40e22a623bc13562f51`;
  [version entrypoint](https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/src/version/index.ts),
  `src/run.ts` and `src/github.ts` cover CLI requirements, package enumeration,
  branch reset, API/CLI pushes, PR creation/update, and error propagation.
- [Create Pull Request 8.1.1 changelog](https://github.com/peter-evans/create-pull-request/releases/tag/v8.1.1),
  commit `5f6978faf089d4d20b00c7766989d076bb2fc7f1`;
  [branch reconciliation](https://github.com/peter-evans/create-pull-request/blob/5f6978faf089d4d20b00c7766989d076bb2fc7f1/src/create-or-update-branch.ts),
  `src/create-pull-request.ts` and `src/github-helper.ts` cover staging,
  cherry-picking/reset, push, signing, ref updates, and post-create retries.
- [release-it 21.1.0 changelog](https://github.com/release-it/release-it/releases/tag/21.1.0),
  commit `ef1f03b3a09d3057c9e1af47879c4deba3f3fd40`;
  [version strategy](https://github.com/release-it/release-it/blob/ef1f03b3a09d3057c9e1af47879c4deba3f3fd40/lib/plugin/version/Version.js),
  `lib/index.js` and `lib/plugin/git/Git.js` cover task ordering, version coercion,
  commit/tag/push, failed pushes, and local/remote rollback.
- GitHub's current [tree](https://docs.github.com/en/rest/git/trees?apiVersion=2026-03-10#create-a-tree),
  [commit](https://docs.github.com/en/rest/git/commits?apiVersion=2026-03-10#create-a-commit),
  [ref](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10#create-a-reference),
  and [PR](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#create-a-pull-request)
  APIs define the selected protocol. The request version remains **2026-03-10**.
  The [GraphQL commit API](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch)
  was inspected as the alternate atomic mechanism. Neither client design turns
  separate service operations into one transaction.

The relevant modernity change is GitHub's
[June 2026 bot-PR CI support](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/).
Preparation uses `GITHUB_TOKEN`, and the operator approves bot-triggered CI if
requested. Older advice requiring a PAT to get any PR CI would add an unnecessary
credential. Merging is a human action; publication follows the documented
[`pull_request: closed` plus `merged` trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#running-your-pull_request-workflow-when-a-pull-request-merges).
No generated-tag push event is relied on to start another workflow. If another
automation merges with `GITHUB_TOKEN`, GitHub may suppress that closed event;
the documented operator flow is a human merge.

Checkout remains SHA-pinned **7.0.1**, with exact `github.sha` and credentials
removed before scripts execute. Its reviewed v7 unsafe-checkout safeguards and
7.0.1 ref/config fixes are covered by the [source/changelog audit](ci-source-audit.md).
Preparation and resolution need full history for ancestry checks and recovery;
ordinary CI keeps its shallow checkout. Ubuntu 24.04 and the locked Nix toolchain
retain the existing tested environment; a newer runner label alone is no benefit.

## Delivered mechanism and invariants

`prepare.js` reads the three committed version files at the selected main revision.
It validates existing agreement, fixed add-on identity and Firefox floor, then
requires a strictly larger numeric version. Only the four root version values
change; JSON output uses the repository's existing two-space formatting. No npm
version/install hooks run and dependency versions/integrities are preserved.
The working tree and normal Git index are never written. A temporary index is
removed in `finally`; locally created Git objects are harmless unreachable objects
until referenced. Interrupted server-side tree/commit creation can likewise leave
unreferenced objects, without creating a release or changing an existing ref.

The returned GitHub tree must equal the tree independently calculated with Git.
The returned commit must have that tree and exactly the selected parent. Only then
does `POST git/refs` expose `release/vVERSION`. This API fails if the ref already
exists; a race cannot turn creation into a ref update. An identical existing branch
is accepted only after checking its parent is in selected main history, its full
tree matches, and its commit message matches (allowing trailing whitespace).
An existing PR must be unique, open, in this repository, and match that head,
base and preparation marker. It is never edited or reopened automatically.
The marker classifies release intent; it is not an authentication secret.

PR merging is the review/authorization boundary. Automatic resolution accepts only
a merged same-repository release PR into main, checks the merge commit's ancestry,
and binds version metadata to that commit. The version must increase over the
recorded preparation base, which must remain in merged history. Merge, squash
and rebase all resolve to the resulting main commit. This also covers a
[merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
containing later non-version commits: comparing only the final commit's parent
would incorrectly reject such a reviewed release. That implementation defect was
found during review, repaired against the original merge contract, and covered
by a new Git integration case before fresh verification. The CI job receives no
write token or AMO secrets.
Only successful CI permits the tag job; tag creation is create-only and an existing
tag must resolve to the exact verified commit, including annotated-tag recovery.
The original signer then rechecks tag identity before AMO writes, and publication
retains its existing digest, source, license, signature and immutability gates.

There is no atomic transaction across PR creation, a human merge, tag creation,
AMO and GitHub publication. Workflow queues serialize their own runs, not external
maintainer activity. Main/ref protections and coordinated publication remain
operating assumptions. An observed conflict fails without overwriting work;
manual edits after a read can still cause a failed run, and reviewed merged source
is always tested again. The workflow never bypasses repository protections.

## Costs, verification and acceptance

A fresh preparation uses **four creation calls**: tree, commit, ref and PR. It sends
three updated JSON files in one tree request. Exact retries after PR creation use
reads and no writes. The temporary Git index scales with tracked paths; JavaScript
holds only the version documents and small API records. Each Git subprocess and
new API call has a 30-second timeout. Git output is capped at 4 MiB per call; job
limits bound total runtime. No timing benchmark or fastest-workflow claim is made.
Current version files and repository history fit those limits; substantial future
growth requires revisiting limits before claiming that expanded scope.

Tests use temporary real Git repositories and an independently staged version-tree
oracle, plus an API model with failures after each remote mutation. They cover
version ordering/limits, dependency preservation, dirty working trees and indexes,
ordinary/annotated tags, three merge methods, ancestry rejection, competing refs,
closed/conflicting/fork PRs, loss of each mutation response, and recovery when main
advances. Transport checks exercise HTTP errors, redirection policy and credential
redaction. Workflow validation uses actionlint and pedantic offline zizmor; the
narrow queue-policy bridge now covers both workflows and rejects negative cases.

The evidence establishes the scoped architecture choice and local verification.
It does **not** establish universal optimality or a completed GitHub-hosted release.
Creating a real PR, bot-CI approval, merge-event delivery, environment permissions,
Mozilla approval and immutable publication require the first authorized live run.
No remote write, push, PR, merge, tag or publication was performed during this
change. Those service acceptance gates remain unverified; the workflows are a
locally verified candidate until that run passes.
