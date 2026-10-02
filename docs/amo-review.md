# Mozilla review handling qualification

> Preserved pre-redesign findings and owner-request record. The current
> controller, source submission and resume planner are described in
> [the redesign qualification](release-design.md) and [operator guide](releases.md).

Reviewed 2026-09-26 against `997087de3e07b3ffb0b3968e1617b80997a42a6b` (`v1.1.4`),
after fast-forwarding the local checkout. A 240-minute total budget began at
16:01:43 UTC and covers investigation, two bounded research delegations, an
independent review, implementation, verification and documentation.
[Releasing Tab Gantry](releases.md) is the operator guide; this record explains the
choices. No push, commit, tag, GitHub setting, AMO submission or AMO edit was made.

## Contract and selection rule

The request applied five earlier recommendations:

1. Never disable a version awaiting Mozilla review by accident; allow it only
   through an explicit choice.
2. A run waiting only for Mozilla must not end as a failure. The GitHub release
   must follow approval without another manual step.
3. Make the repository settings the guide assumes applicable and checkable.
4. Decide whether source archives remain attached.
5. Bring the checkout up to date, keep the listing icon out of the package, and
   correct the README.

Every existing publication guarantee remains a feasibility constraint: the exact
tested payload, add-on identity, license and source checks, no overwrite of
observed state, bounded waiting, least credentials per job, and recoverable
partial states. Among feasible designs the rule prefers fewer operator steps,
fewer credentials and permissions, less new mutable state, and compatibility
with existing tags. No latency, throughput or universal-optimality claim is made.

## Evidence that decided the design

| Question | Finding | Source |
| --- | --- | --- |
| What disables a pending version? | `Version.from_upload()` calls `disable_old_files()`, which disables every older listed file awaiting review. The upload alone does not. | addons-server `4b4e5bb`, `src/olympia/versions/models.py` lines 511 and 966–984 |
| How are versions listed? | `filter=all_without_unlisted` lists all non-deleted listed versions for authors. "Awaiting review" serializes as `unreviewed`. Pages hold at most 50. | same revision, `addons/views.py` 600–700, `constants/base.py` 40–52, `api/pagination.py` |
| Why did the first release never fit a 20-minute wait? | A first listing needs human review. A nominated add-on's new version is also held back from automatic approval for `INITIAL_AUTO_APPROVAL_DELAY_FOR_LISTED`, 24 hours by default and configurable in AMO's database. | `reviewers/models.py` 642–664, `constants/config_keys.py` 53–55 |
| Is a 15-minute wait useful later? | The last public schedule ran automatic approval every 5 minutes. It was reference-only and removed in December 2024, so the production schedule is not public. | `scripts/crontab/crontab.tpl` at `c8f5e7c` |
| Can the preparation job, which has no AMO credentials, see pending versions? | No. The anonymous API returns 401 for Tab Gantry's nominated listing and 404 for absent versions. It shows only approved listed versions of public add-ons. | live read-only requests, 2026-09-26 |
| Which ref do environment branch rules check? | The run's `GITHUB_REF`, which is `refs/heads/main` for a merged pull request, so a `main` rule admits automatic releases. | GitHub [deployment branches](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags), [pull_request event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) |
| Can a workflow resume another? | A `workflow_dispatch` created with `GITHUB_TOKEN` always creates a run, needs `actions: write`, and at API version 2026-03-10 returns the new run's URL. | [triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow), [dispatch API](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event) |
| Can the release workflow's token bypass a tag-creation rule? | Not on a user-owned repository: GitHub rejects the GitHub Actions app as a bypass actor there. | [rulesets API](https://docs.github.com/en/rest/repos/rules?apiVersion=2026-03-10), community report linked in the research notes |

## Alternatives

| Mechanism | Decisive property | Disposition |
| --- | --- | --- |
| Previous flow: poll 20 minutes, fail, rerun by hand after approval (control) | Every first release and every slow review ends red. A forgotten rerun leaves no GitHub release. Merging the next release PR silently disabled 1.1.0, 1.1.2 and 1.1.3. | Replaced |
| Document "wait before merging" only | Already documented as "merge one before preparing the next"; did not prevent the three disabled versions. | Rejected: no enforcement |
| Pending check during preparation | Preparation deliberately holds no AMO credentials, and the anonymous API cannot see pending versions. | Rejected: needs a new credential in a job that must not have one |
| Pending check in the signing job before creation | Holds the only AMO credentials, runs exactly before the one call that disables. A check-then-create window remains; AMO offers no conditional create. | Selected |
| `web-ext sign` 10.7.0 | 15-minute default wait; fails on timeout; with `approvalTimeout` 0 it succeeds without the file. Always creates a version; no pending check. | Covered: same wait semantics, no guard, no resume |
| `kewisch/action-web-ext` v2.0, `wdzeng/firefox-addon` v1.2.1, `PlasmoHQ/bpp` v3.8.0, `creeperkatze/extension-publish` v1.0.12, `baptistecdr/release-firefox-addon` v2.1.0, `violentmonkey/amo-upload` 1.1.0 | None checks for another pending listed version. Only the last two look up an existing version first. None publishes elsewhere after approval. Several lack custom license text or working source upload. | Rejected: each misses a required property |
| Wait longer inside the job | GitHub-hosted jobs stop after 6 hours; human review can take days; the runner is held idle. | Rejected |
| Environment wait timer or custom deployment protection rule | A timer is a fixed delay, not a condition. A protection rule that polls AMO needs a hosted GitHub App: new infrastructure and credentials. | Rejected for this project's scale |
| AMO event notification | AMO has no developer webhooks; approval arrives by email only. | Not available |
| Scheduled poll that dispatches the existing publisher | Needs no secrets and only `actions: write`; reuses every publication gate; bounded per run and per tag. | Selected |

## Delivered mechanisms and invariants

**Pending guard** (`scripts/release/amo.js`). Runs only on the creation path.
It lists listed versions, fails closed on unexpected entries or more than 20
pages, and blocks when any version other than the target is `unreviewed`. The
override must equal the single pending version. It runs before upload and again
after validation, before creation. Both times the existing tag check runs first,
so a moved tag is still reported ahead of a pending version, and runs again right
before the write. A block is a failed run with an error annotation and a summary
giving both ways forward, because it needs a person.

**Awaiting state.** `signRelease` returns `awaiting-review` only at the loop point
where the version exists, its payload, channel and license match, and its source
is attached and verified. The client's 20-minute signal still bounds every
request, including work after approval appears late in the wait. The sign step
publishes `state`; the release workflow skips verification, artifact upload and
publication only for exactly `awaiting-review`. The sign job runs the release
commit's signer, and older signers set no output and succeed only after approval,
so the negative condition keeps `v1.1.4` and earlier tags publishable.
`release.json` and `signing.json` keep their previous contents.

**Resume approved releases.** Reads tags and published releases, then asks the
public AMO API, with no credentials, whether the listing is public and each
unpublished version is approved. It dispatches the oldest approved tag on `main`,
at most one per run, never while a Publish release run is queued, running,
waiting, requested or pending, and at most twice per tag. Dispatches are recognized
by the new run name and by `actor`, the account that started the run, which a
rerun does not change; runs started by people do not count. When a tag reaches
the limit, the scheduled run fails: failures of bot-started runs notify nobody,
while a failed scheduled run notifies the user who last changed the schedule.
Service errors, 429 responses and GitHub's rate-limit 403 responses end the run
successfully with a warning; other errors and malformed data fail it.

**Repository policy** (`scripts/release/repository-policy.js`). Checks the tag and
default-branch rulesets, both environments' deployment branches, immutable
releases and Actions pull-request creation. `--apply` creates or updates only
those, keeps environment reviewers and wait timers and extra ruleset rules, never
deletes, never follows a redirect with the token, and checks again afterwards.
A tag creation rule is drift that `--apply` removes from its own ruleset. In any
other active ruleset, a creation rule covering `v*` tags or `release/v*` branches
is reported for manual removal, since `GITHUB_TOKEN` cannot bypass rulesets here.

**Source archives stay attached.** `extension/name-catalog.js` is generated by
`scripts/compile-names.js`. Mozilla requires source for files made by "any other
custom tool that takes files, applies pre-processing, and generates file(s)"
([source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)),
so source is required, not optional. Attached source only
notifies reviewers and flags the queue; it is not an automatic-approval criterion
(`flag_if_sources_were_provided` in `versions/models.py`). The README now gives
reviewers the exact build steps.

**Housekeeping.** The checkout fast-forwarded two commits. The untracked listing
icon moved from `extension/icon.png` to `listing/icon.png`, so local packages now
equal clean-checkout packages. The release-test fixtures now ignore the
developer's global Git configuration: `tag.gpgSign true` had failed two tests
locally, while CI was unaffected.

## Independent review

A separate reviewer read the integrated change, ran the suites and reproduced
findings with mocked services. It found no high-severity defect. All four
findings were confirmed and fixed, each with a test that fails on the old code:

| Finding | Fix |
| --- | --- |
| A tag that failed two automatic publications was never reported: the scheduler ended green, and failures of bot-started runs notify nobody. | The scheduled run fails while any approved tag needs a person. GitHub [notifies the user who last changed the schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). |
| Attempts were counted by `triggering_actor`, which a person's rerun changes, so each rerun allowed one more automatic attempt. | Count by `actor`, the [account that started the run](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts). Every approved tag is evaluated, so a stuck tag listed after a dispatchable one is still reported. |
| The pending check preceded the moved-tag check, so a moved tag with a pending version produced `supersede` advice. | The tag check runs first again, and again right before each write. |
| The policy tool accepted a tag creation rule in its ruleset, which would block every release's tag job. | Tag creation rules are drift, removed by `--apply`; other blocking rulesets are reported. |

Its two documentation points are also applied: GitHub's rate-limit 403 responses
now count as temporary, and the guide says that tags created before this change
carry signers without the pending check.

## Verification

Commands ran inside `nix develop` with Node 24.20.0, actionlint 1.7.12 and
zizmor 1.30.1 on Linux x86-64. [The evidence record](../evidence/release/amo-review.json)
lists toolchain versions, results and the SHA-256 of every changed file.

| Check | Before | After |
| --- | --- | --- |
| Release tests (`npm run test:release`) | 87 of 89 pass locally; the 2 failures come from the global Git config | 124 of 124 pass, with and without that config |
| Unit, installer and alternative tests | 153, 9, 74 pass | unchanged, all pass |
| Typecheck, extension lint, catalog | pass | pass |
| actionlint with the queue bridge, pedantic zizmor | pass (3 workflows) | pass (4 workflows) |
| shellcheck, nixfmt | pass | pass |

Mutation checks broke each new mechanism in turn, including the review fixes:
34 of 34 were detected by a failing test, after one pattern-matching test that
missed a mutation was made discriminating. The working tree was restored byte for
byte after each. A Firefox 156.0 package test passed on the package without the
listing icon: temporary installation, all 13 files matching `extension/`, real
grouping and naming.

Live read-only checks on 2026-09-26:

- The new owner listing made one GET and showed 1.1.4 `unreviewed` and 1.1.0,
  1.1.2 and 1.1.3 `disabled`. The guard would refuse a 1.1.5 submission now and
  does not affect resuming 1.1.4.
- A dry run of the resume planner read tags and releases, received AMO's 401 for
  the nominated listing, made no version requests and proposed nothing.
- Public AMO and GitHub responses have the fields both new scripts read.
- The policy tool read the public rulesets and environments, handled GitHub's 404
  for the branch-policy list, and stopped at the administrator-only immutability
  check with its intended message.
- The reviewer build steps, run in a clean checkout with only `node` and `zip` on
  `PATH`, reproduce the development package digest
  `40940f0fd760013d94c7451229c6bf299e6008ebaae7894034b1accdf49edf0c`.

## Open acceptance gates and limits

- The changed workflows have not run on GitHub; nothing was pushed. The first
  merged release PR or Publish release dispatch must confirm the step outputs,
  job conditions and run name. The first approval after merging must confirm
  that Resume approved releases dispatches and publishes.
- The policy tool has not written to GitHub; no administrator token was available.
  Its writes follow the REST reference and are tested against a model. Run its
  check mode first.
- A rejected version is invisible to the anonymous API, so it looks like one
  still in review. Nothing is published; Mozilla's email is the signal.
- GitHub disables scheduled workflows after 60 days without repository activity,
  and may delay or drop scheduled runs under load. Manual dispatch remains the
  fallback.
- The check-then-create window, and edits made outside this workflow, are
  narrowed, not eliminated.

The delivered design is qualified for this repository, the listed channel and
the sources above. That is a scoped engineering finding, not a proof that no
better design exists.
