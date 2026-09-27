# Releasing Tab Gantry

The [Tab Gantry rename](tab-gantry-rename.md) covers unlisted 1.1.8, listed 1.1.9,
and the owner's explicit replacement of pending 1.1.7. Keep the established ID
and historical release identities when recovering older versions.

**Release** prepares a version PR. Human merge authorizes submission to the
existing listed Mozilla add-on and subsequent GitHub publication. **Publish
release** tests the frozen source, submits or reconciles that version, verifies
the signed XPI in Firefox 156, and publishes a complete immutable GitHub Release.
**Resume approved releases** continues after a long Mozilla review.

The controller is deployed and has passed local and hosted CI. End-to-end
publication and update acceptance remain pending; [hosted acceptance](release-acceptance.md)
records the owner-authorized setup, real runs and remaining Mozilla gates.
The owner later authorized [unlisted 1.1.6](unlisted-1.1.6.md) as a one-off
self-distributed release. Use that page for this version; the normal workflow
below remains listed-only.
The subsequent [listed 1.1.7 plan](listed-1.1.7.md) records the corrected merged-PR
trigger, its scoped Actions event policy, recovery from an incomplete listing,
and retirement of unsubmitted 1.1.5.
See the [design qualification](release-design.md) and [verification record](../evidence/release/redesign.json).
The supplied operator guide, including all existing edits, is preserved in
[release history](release-history.md). Use this page for current procedures.

## Setup before publication

These administrator actions require authorization separately from implementation:

1. Enable **immutable releases before publication**. Verification afterward
   cannot undo a publication made with the setting off. The ordinary workflow
   token cannot read this administrative setting.
2. Create `release-signing` and `release-publication` environments with explicit
   deployment **branch** policies allowing only `main`. For unattended completion,
   use human PR merge as approval and configure no additional environment
   reviewers/timers. Deliberately configured reviewers introduce another manual
   step; the workflow does not remove them.
3. Put `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in **release-signing only**, using the
   existing add-on author's AMO API credentials. Local `.env` uses `JWT_ISSUER`
   and `JWT_SECRET`; workflows never read it. Keep it ignored. Rotate the secret
   in AMO and this environment together. Request JWTs last five minutes; their
   signing secret is long-lived.
4. Allow Actions to create PRs in **Settings → Actions → General → Workflow
   permissions**. Preparation never approves or merges them. A writer may need
   to approve CI on a bot-created PR.
5. Protect `v*` tags against updating/deleting and `main` against force pushes
   and deletion. Permit creation of `release/v*` branches and `v*` tags by
   `GITHUB_TOKEN`. No bypass or force push is used. Review changes to release
   workflows/dependencies through normal source review.
6. Keep **Resume approved releases** enabled and monitor failed runs. GitHub
   can delay/drop schedules and disables schedules in inactive public repositories
   after 60 days. Keep the schedule owner's notifications enabled.
7. Keep the **Stackma release workflow events** Actions policy active. It applies
   only to `.github/workflows/release.yml` and allows `pull_request_target` and
   `workflow_dispatch`. The target trigger runs only for merged, same-repository
   release PRs whose integrated source passes the main-history checks. This
   explicit policy is needed when GitHub's public target-event default becomes
   enforced on 2026-11-02. Do not broaden environment access to PR merge refs.

The policy helper checks without writing unless `--apply` is explicit. It needs
an administrator's token, separate from the publisher's job token:

```sh
nix develop .#release
gh auth login
node scripts/release/repository-policy.js --repository=Quince-Pie/stackma
# Only after reviewing and authorizing settings changes:
node scripts/release/repository-policy.js --repository=Quince-Pie/stackma --apply
```

It preserves existing reviewers/timers: inspect those separately for unattended
completion. It checks declared settings and common creation conflicts, not every
possible account/organization rule or credential scope. No extra publication PAT
is assumed; historical-tag permission behavior is an acceptance case below.

The initial 2026-09-26 anonymous inspection found **no rulesets**, only `release-signing`
with **no branch restriction**, and no `release-publication` environment.
Administrative settings and stored secrets were not inspected at that stage.
The later [authenticated rollout](release-acceptance.md) records the completed
policy setup and the remaining publication/update gates.

## Normal operation

1. Put reviewed changes on `main`. Select **Actions → Release → Run workflow**,
   branch **main**, and an unused version, for example `v1.1.5`:

   ```sh
   gh workflow run prepare-release.yml --ref main -f version=v1.1.5
   ```

2. Review the generated PR and passing checks, approve CI if requested, then
   merge. It updates the manifest/package versions and both root lockfile
   versions and adds `release-intents/vVERSION.json`. Normal, squash, rebase
   and merge-queue integration are supported.
   Prepare one version at a time. Do not create a tag or GitHub Release manually.
3. **Publish release** verifies the integrated commit and creates its tag after
   CI. New submissions attach the source in the version-creation request and
   inherit the exact verified WTFPL/CMU terms from the newest created listed
   version. The controller never edits licenses.
4. Approval within the approximately 15-minute wait continues in the same run.
   Otherwise a verified pending submission finishes green as **awaiting review**.
   **Resume approved releases** checks every six hours and dispatches after
   public approval. This cadence is not a delivery SLA; Mozilla review, runner
   queuing and schedule delivery are external.

To complete sooner or recover using corrected controller code:

```sh
gh workflow run release.yml --ref main -f tag=v1.1.4
```

This requires an existing prepared tag. If verification failed before tag creation,
rerun the original merged-PR run, which retains authority to create it. A rerun
uses its old workflow revision; a new dispatch from main uses corrected release
code. If the original run is unavailable or its code needs a fix, specify the
actual **merged release PR** as well as its matching tag:

```sh
gh workflow run release.yml --ref main -f tag=v1.1.5 -f pull-request=RELEASE_PR_NUMBER
```

The controller reads that PR and its unique merged event, then applies the same merge, repository, branch,
marker, version and ancestry checks. It tests the resolved source before creating
the missing tag. This input cannot authorize an unmerged PR or an arbitrary commit.

Intent is committed with the version PR, before any tag or AMO request. Keep
these records unchanged; they are part of protected source history. The source
version must be the newest inventoried version: do not merge stale version PRs
after a higher version. An earlier source-declared intent with no observable AMO
result blocks a later submission even when its tag is still invisible after a
timeout. Resume that earlier release (its original merged-PR run if its tag is
missing); never remove an intent or delete a tag to bypass uncertainty.

Wait for the pending version's decision before merging another release PR.
Mozilla disables older pending listed versions when a new version is created.
To deliberately replace the exact single pending version, first obtain the new
version's prepared tag, then explicitly choose the destructive effect:

```sh
gh workflow run release.yml --ref main -f tag=v1.1.5 -f supersede=1.1.4
```

Ordinary/scheduled paths leave `supersede` empty. Multiple pending versions, or
a different observed pending version, stop submission. Checks run again after
upload validation. Closing an unmerged release PR does not release anything;
preparation never reopens, rewrites or deletes existing branches/PRs.

## What is released and trusted

The source commit is frozen; the trusted controller comes from the reviewed main
workflow revision. Source build/tests and lockfiles remain at the release commit.
Staging, signing, signed installation verification and publication use the current
controller. Historical release scripts never execute with AMO credentials.
`--source-root` selects the frozen files for the current installation verifier.

The AMO step alone receives its credentials; GitHub publication has only its
repository write token. Within-run artifacts are selected by exact artifact ID
with digest mismatch fatal. Recovery rebuilds/retests from the protected tag and
locked tools, so expired 14-day unsigned/30-day signed artifacts are not the sole
recovery source. Source and pinned tool downloads must remain available.

The controller verifies AMO's archive hash/size and compares every payload member
against the tested unsigned XPI, allowing only recognized signature additions.
Firefox independently verifies permanent installation/signature, exact packaged
files, grouping and naming. AMO's HTML license representation is checked without
accepting changed terms or link destinations.

New Tab Gantry releases have four assets: `tab-gantry-VERSION.xpi`,
`tab-gantry-VERSION-source.zip`, `release.json` and `SHA256SUMS`. Draft assets must
match by name, size and SHA-256. Only a complete draft is published; the immutable
release and every asset's native release attestation are then verified. That
attestation proves membership/bytes, not independent build provenance or a SLSA
level. A delayed older release does not displace a newer Latest release.
Keep the generated identity marker at the beginning of release notes; it identifies
controller-owned publications for recovery.

Versions through 1.1.7 retain their original `stackma-` asset names and record
format. Branding is read from the frozen release source, so a later rename does
not rewrite an older release. The add-on ID, AMO slug, repository URL, ownership
markers and existing Actions policy/concurrency names remain stable identifiers.

AMO may make the listed version available before GitHub publication. There is no
cross-service transaction or rollback. Firefox keeps ID `stackma@extensions.local`,
minimum version `156.0`, and the existing AMO update path without a custom update
URL. GitHub distributes the same listed signed package.

Coordinate **one release writer**, including manual Developer Hub/GitHub actions.
Queues serialize workflows, not outside administrators. AMO has no conditional
predecessor/license/source write. Inherited licenses share an object; never edit
one as routine recovery. The [design record](release-design.md) states the
remaining race boundaries and all scan/time/resource limits.

## Recovery

| Observation | Action / expected result |
| --- | --- |
| Preparation/tag response lost | Repeat the same authorized operation. Matching tree/ref/PR is reused; conflicting work is preserved. |
| Another pending version | Wait and resume, or use the explicit `supersede` choice. No accidental replacement. |
| Upload reply/validation lost or expired | Resume: query the version first, otherwise upload fresh bytes. No cached UUID is blindly reused; orphan uploads are left for Mozilla's cleanup. |
| Version-create reply lost | Resume and verify the existing version before another create. Source travels in the same request. |
| Earlier tag exists but AMO still shows no version | The next submission stops even if the pending list is empty. Resume the earlier tag to settle its outcome before advancing. |
| Earlier intent exists but its tag is not visible | The next submission also stops. Tag creation itself may still be running; recover its merged-PR run or dispatch main with that PR number before advancing. |
| Review takes days | A verified pending version ends green; scheduled completion requires no routine extra action. |
| Version/listing rejected or disabled | Inspect Mozilla's review message. Automation never re-enables/deletes it. Anonymous polling cannot distinguish every nonpublic cause. |
| Build/upload validation permanently fails before a version exists | Retire the unsubmitted intent through the reviewed procedure below, then prepare the corrected higher version. |
| Old version lacks source | Verify payload/license before attaching only missing source. After human review, AMO may refuse: contact Mozilla or prepare a fresh version after resolving review. Never overwrite observed source. |
| Missing/different inherited license | Inspect the newest created listed version, including disabled ones. Resolve history deliberately; no license substitution or automatic rewrite. |
| Tag, payload, source or license conflict | Preserve both sides and investigate; never move a tag or silently accept different bytes. |
| Inputs expired | Dispatch from main; reconstruct/retest, then compare against AMO. No old artifact ID is needed. |
| Draft create/upload reply lost | Reconcile by validated release ID and exact digests; upload only missing assets. |
| Incomplete `starter` upload, unexpected assets, duplicate drafts | Stop and preserve state. Cleanup of the inspected exact ID is a separate authorized repair. |
| Publish reply lost or attestation delayed | Verify the existing publication; never delete/recreate it. Attestation reads retry a bounded number of times. |
| Bot run publishes but fails final verification | Scheduler checks the actual publication-verification job step, retries within the existing allowance, then reports attention with the run URL. A green skipped publisher is not verification; a failed diagnostic upload after successful verification is not a failed release gate. |
| Published release mutable/incomplete | Preserve it. Correct setup and use a fresh version or obtain specific owner instructions. Immutability cannot repair it retroactively. |
| New controller reconstructs different audit bytes for an existing draft | Stop rather than overwrite. Inspect inventory and recover with the original run/toolchain; payload/source identity must still match. |
| Two automatic completions fail | Scheduler reports attention. Fix the cause and dispatch manually. Cap counts retained bot-started runs, including human reruns; deleted/expired history cannot enforce a lifetime cap. |
| History changes or a bound is reached | Report attention rather than pretend a partial search is complete. Inspect and resume affected tags explicitly. |
| Schedule/credentials/provider unavailable | Restore the authorized setting or credential, then dispatch. Transient service outages defer to the next check. |

The planner considers all canonical unpublished tags, without the previous
newest-20 exclusion. It chooses point lookups or public-version pages by remaining
request counts, dispatches at most one approved tag (oldest first), and waits while
a publisher is active. Ambiguous dispatches are not retried in the same run.

Published-release monitoring uses retained bot-run evidence and, when needed,
later human recovery runs. Missing/expired history is not lifetime proof of
completion. Human-triggered failures also need the initiating maintainer to follow
their notification. The planner never deletes a public release to retry it.

### Retire an unsubmitted version

Intent records stay immutable. To abandon a version that cannot pass build or
upload validation, first stop further attempts and establish that **no tag or
AMO version-creation request remains in flight**. Inspect all attempts. A build
failure before submission is evidence; an ambiguous timeout or an AMO 404 alone
is not. If a create might still be running, recover the same version or obtain
Mozilla/GitHub confirmation before retiring it. Resolve any visible pending
version through the normal review/supersede procedure.

Then submit a separate human-reviewed change to `release-retirements.json`,
leaving the original intent and tags intact. For example:

```json
{
  "v1.1.5": {
    "reason": "Build validation failed before submission; replaced by corrected source",
    "evidence": "Record the inspected run/attempts and how their outcomes were established",
    "noInFlightRequests": true
  }
}
```

Replace the example evidence with the actual non-sensitive evidence. This is an
explicit operator assertion, **not machine proof of provider cancellation**.
After review/merge, the current controller refuses that target and allows a
higher release to advance past that resolved intent. The ordinary pending-version
guard remains active; retirement never authorizes disabling a pending version.
Never rerun an old controller that predates the retirement; use dispatch from
current main for further recovery. A retirement with an unknown outcome is unsafe
and is outside the operated contract. Version 1.1.5 is retired with the
[recorded pre-execution failure](listed-1.1.7.md); its tag and intent remain intact.

## Existing versions and rollout

Current and historical release states are recorded separately; observations are
not reservations or approval:

- **1.1.4**, commit `997087de3e07b3ffb0b3968e1617b80997a42a6b`, AMO version
  `6511539`, was initially unreviewed with matching source. The owner subsequently
  disabled it; preserve that state.
- **1.1.5** was tagged but its signing job never started. Its unsubmitted intent
  is explicitly retired with [pre-execution evidence](listed-1.1.7.md).
- **1.1.6** is signed, verified and published for [unlisted self-distribution](unlisted-1.1.6.md).
- **1.1.7** is [submitted to the listed channel](listed-1.1.7.md), awaiting Mozilla
  review. It retains the same ID and can update installed 1.1.6 after approval.
- **1.1.0, 1.1.2 and 1.1.3** have disabled AMO files. Preserve them. Older missing
  sources and the normalization incident are recorded in [AMO formats](amo-formats.md).
- **v1.1.1** is immutable with no assets, at a commit declaring 1.1.0. It cannot
  be reused or supplemented. An explanatory note edit requires separate remote
  authorization.

Retain existing tags, releases, PRs and submissions. The controller redesign
preserved product behavior and licenses; the subsequent 1.1.6 and 1.1.7 releases
change only product version fields.

During rollout, let all old release runs finish and ensure there are no queued
old controllers or manual submissions. Inventory tags against AMO versions before
enabling the new controller. The migration record seeds **v1.1.4**, the existing
pending version; 1.1.2/1.1.3 are terminal disabled history and v1.1.1 is already
published. Commit this seed with the controller. Pre-inventory source can resume
an existing AMO version, but cannot start a fresh submission. New preparation
requires the audited inventory. Never silently abandon admitted intent; damaged
or out-of-order inventory needs an explicit owner-reviewed migration.

Before accepting the candidate, an authorized maintainer must:

1. Review/merge it and complete administrator setup above.
2. Exercise hosted PR creation/CI approval/human merge; confirm exact commit,
   artifact IDs, queue behavior and credential/environment scopes.
3. Exercise new source-on-create submission, inherited terms, reviewer source
   access, delayed review and automatic resumption.
4. Complete signed permanent installation, all four assets, immutability and
   attestations; repeat completion and recover an old tag with changed workflow
   code. GitHub's historical-target workflow-write scope remains a hosted
   acceptance uncertainty: a 403/404 does not authorize new tags or broader tokens.
5. Confirm Firefox updates an existing installed copy through AMO with the same
   ID. Source analysis establishes the intended path, not hosted update delivery.

## Local verification

```sh
nix develop
npm ci --ignore-scripts
npm run check
npm run test:ci
npm run test:release
npm run test:alternatives
npm run check:catalog
node scripts/ci/check-workflows.js
zizmor --offline --persona=pedantic .github/workflows
shellcheck scripts/ci/*.sh
nix flake check --all-systems --no-build --no-update-lock-file
nixfmt --check flake.nix
node scripts/release/resume.js --dry-run --repository=Quince-Pie/stackma
```

Use a disposable checkout for build/browser checks to preserve local work:

```sh
npm run test:firefox
npm run test:metadata
npm run test:naming
npm run test:native-ids
node scripts/release/check-version-format.js
node scripts/build.js
node scripts/package-test.js --output=artifacts/package.json
# Current controller, approved signed package and frozen product files:
node scripts/package-test.js --source-root=/path/to/frozen/source \
  --signed --xpi=/path/to/signed.xpi --output=artifacts/signed-package.json
```

Local tests, mocks, read-only reconciliation and workflow lint do not establish
publication success or universal optimality. The evidence record separates those
checks from the remaining hosted acceptance gates.
