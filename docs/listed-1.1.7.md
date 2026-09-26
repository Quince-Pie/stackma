# Listed 1.1.7 and recovery from an incomplete listing

The owner requested **1.1.7 on addons.mozilla.org**, after installing signed
unlisted 1.1.6. The product change is only the next version. Keep the same
`stackma@extensions.local` ID and default AMO updater so approved, compatible
listed 1.1.7 can update installed 1.1.6. Preserve the owner's disabled 1.1.4 and
the existing immutable GitHub releases. No pending version is superseded.

## Why the earlier attempt did not submit

[1.1.5 run 36274506473](https://github.com/Quince-Pie/stackma/actions/runs/36274506473)
verified and tagged its source, but GitHub rejected the signing job before
allocating a runner: `runner_id: 0`, `steps: []`. The environment annotation names
`refs/pull/5/merge` as disallowed by the `main`-only signing policy. No signer step
could have issued an AMO request. The complete retained workflow history contains
one 1.1.5 attempt, no active publishers, and the owner version inventory has no
1.1.5. This is evidence of a pre-execution stop, not an inference that a timeout or
404 cancelled provider work.

The reviewed retirement policy retires only **v1.1.5**, preserving its intent
and tag. Current tooling refuses to resume it and permits the later requested
version to advance. This assumes the coordinated publishing procedure: no
independent 1.1.5 Developer Hub submission was reported or observed.

## Trusted merged-source initiation

Published GitHub event documentation says a merged `pull_request` exposes the
destination branch as `GITHUB_REF`; the observed deployment-policy evaluation
nevertheless used the PR merge ref. That difference invalidates the earlier
assumption that ordinary merged-PR events can enter these environments. Their
main-only restriction remains in place.

Use **`pull_request_target: closed`** with all of these existing gates:

- The PR must be merged, target main, originate in this repository, and use the
  canonical release branch and preparation marker.
- The integrated commit must be in fetched protected main history; never
  substitute the PR head. Controller code stays pinned to the trusted default
  branch event SHA, even when that snapshot precedes the integrated source.
- Immutable intent, retirement, version and channel checks precede CI, tag
  creation and signing. Full verification runs on the frozen source.
- Only designated jobs receive write permissions or environment secrets.
  Unmerged/fork source never reaches those jobs. No unsafe-checkout or cache-write
  opt-in is used.

Zizmor flags this trigger categorically. Its `dangerous-triggers` finding has one
explicit annotation with the trust argument above and regression checks for the
guards; the remaining audits continue to run. A clean lint result is not proof
of this trust boundary. Hosted acceptance must show that the merged release's
signing job actually starts under the unchanged branch policy.

GitHub's public-repository default event policy begins enforcement on
**2026-11-02**. The policy helper checks/applies an active event policy scoped to
**`.github/workflows/release.yml` only**, allowing `pull_request_target` and
`workflow_dispatch`. It preserves added restrictions, does not relax other
policies, and reports inherited/actor constraints for manual review. Current
administrator inspection found no existing or inherited policy. Runtime jobs
receive no administrator token.

Alternatives were checked against the same source/credential contract. Allowing
`refs/pull/*/merge` in secret environments would admit PR-context workflow code
and weaken the existing trust boundary. A post-tag dispatch to main adds another
run and full CI pass. An earlier dispatch avoids that duplicate CI, but needs a
new handoff plus submission/recovery classification to preserve retry counts and
publication monitoring. The guarded default-branch trigger retains those
mechanisms with one CI pass; its administrative requirement is explicit and
checkable. This is scoped qualification, not universal dominance.

Primary references, inspected 2026-09-26:
[workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target),
[target-event security and policy](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target),
[Actions policies API](https://docs.github.com/en/rest/actions/policies#create-a-repository-actions-policy),
[environment rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags).

## AMO submission and acceptance

An enabled **incomplete** listing is eligible for a new listed version. AMO's
deployed serializer rejects disabled/rejected listings; it does not reject this
state. The controller therefore admits `incomplete` while retaining identity,
enabled-state, prior-intent, pending-version, exact-license and source checks.
A listed file alone is insufficient for publication: both the file and the
public listing must be approved.

Source is attached during version creation. License inheritance uses the latest
created **listed** version, currently disabled 1.1.4, not unlisted 1.1.6. Its
complete WTFPL/CMU terms must match before creation and afterward. No existing
version or license is edited.

These mechanisms were inspected at AMO deployment `2026.09.17-1`, commit
`c03d3c661bdbe22bb8f4a52fc46d63668bb31751`: the
[version serializer](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/addons/serializers.py),
[version model](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/versions/models.py)
and [listing status](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/addons/models.py).
Published interfaces are described by the [v5 API](https://mozilla.github.io/addons-server/topics/api/addons.html).

After the controller fix and policy are verified, use normal **Release**
preparation for v1.1.7, approve its CI, review the version-only PR and merge it.
The existing publisher submits to the listed channel and resumes after approval.
Mozilla controls listing review; submission is not public availability.

Once 1.1.7 is approved and its signed digest verified, exercise the actual Firefox
update service from signed 1.1.6 in a disposable profile:

```sh
node scripts/release/update-test.js \
  --from-xpi=/path/to/verified/stackma-1.1.6.xpi \
  --from-version=1.1.6 --to-version=1.1.7 \
  --to-sha256=VERIFIED_SIGNED_1_1_7_SHA256 \
  --output=artifacts/update-1.1.6-to-1.1.7.json
```

That test checks native group metadata, extension storage and the actual download
bytes. It must wait for AMO approval; mocks do not establish update delivery.
The [recovery evidence](../evidence/release/listed-recovery.json) records source
findings, retirement authority and local checks. Live submission, approval,
publication and update results are separate acceptance stages.
