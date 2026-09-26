# Stackma 1.1.6: explicitly authorized unlisted release

**Published 2026-09-26:** [signed XPI and release assets](https://github.com/Quince-Pie/stackma/releases/tag/v1.1.6).
Mozilla version `6517542` is approved in the unlisted channel. Permanent Firefox
156 installation, all four native GitHub asset attestations and unauthenticated
download hashes passed. The [acceptance evidence](../evidence/release/unlisted-1.1.6.json)
records the exact source, hashes, CI and recovery of the initially delayed draft
visibility. The existing draft was reused; nothing was deleted or replaced.

On 2026-09-26 the owner requested unlisted **1.1.6**, changing only the product
version, to seek earlier signing. This supersedes the previous listed-only
distribution scope for this version. The owner also confirmed disabling 1.1.4.
Current main already contains the separately merged 1.1.5 version change at
`820c43cc27f7e943a97c1bc50476cf7d7f77bf36`; that work is preserved.

The extension keeps its ID, Firefox 156 minimum, permissions, behavior, default
AMO updater, WTFPL and CMU terms. Only the four version fields change. The
committed `release-exceptions/v1.1.6.json` binds that constraint to the prior
source. Local uncommitted metadata cannot select the distribution channel.
Normal listed submission refuses this unlisted source before creating a tag.

## Distribution and update consequences

Unlisted means Mozilla signs the XPI for self-distribution; it does not publish
that version on the AMO listing. GitHub remains the existing download channel.
It is not a bypass of validation, add-on policies or possible manual review.
Signing may be faster; there is no signing deadline guarantee.

Users install the signed XPI through Firefox's **Install Add-on From File**.
Existing installations do not receive this unlisted version from AMO. Keeping
the same ID and absent `update_url` lets installed 1.1.6 receive a later compatible
**listed version higher than 1.1.6**. Listed 1.1.4 or 1.1.5 cannot update it.
This release can establish permanent signed installation and GitHub publication;
it cannot establish the earlier default-AMO installed-user update acceptance.

The Developer Hub's **AMO: Incomplete / Self: Latest Version 1.1.6** display is
consistent with this release. AMO's listing status is calculated from listed
versions; after the owner disabled 1.1.4 there are no approved or awaiting-review
listed versions. The signed unlisted file is independently approved. The live
listing API still reports its September 23 creation date as `last_updated`; that
field is not evidence that the September 26 signing failed. Making the public
listing available requires a later listed submission and Mozilla approval.

## Mechanism and qualification

This is a scoped operator path, not a new default hosted release channel.
Preparation still uses a reviewed version PR and merge before any upload.
The operator command requires passing hosted CI on the exact merged main commit,
rebuilds the committed source inputs, reconciles the protected tag, then reuses
the existing payload/source checks, permanent Firefox signature test, four-asset
GitHub reconciliation, immutable publication and native attestation verification.
Its PR branch is `codex/unlisted-v1.1.6`, so merging it does not initiate the
listed publisher.

The maintained `web-ext sign` alternative can request unlisted signing, but does
not provide this project's exact existing-version, source, license and partial
GitHub reconciliation. Extending hosted scheduling would require authenticated
unlisted status access in another job. For this single requested release, reuse
the narrow AMO v5 client and verified publisher from an authenticated local
operator session. Hosted credential scopes and listed scheduling are unchanged.
This is a bounded engineering choice, not a latency or optimality claim.

AMO only inherits license metadata for **listed** versions. For unlisted creation
the source is attached in the version POST; after verifying that payload and
source, the command sets only a missing custom license to the exact existing
WTFPL/CMU terms. It creates a new license object and never edits the listed
version's license. A matching observed license is preserved, and a conflict
stops publication. Lost write responses are reconciled by GET on the next run.

Primary evidence, inspected 2026-09-26:

- [Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
  and [self-distribution updates](https://extensionworkshop.com/documentation/publish/self-distribution/).
- AMO production reports release `2026.09.17-1`, commit
  `c03d3c661bdbe22bb8f4a52fc46d63668bb31751`. Its
  [version model](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/versions/models.py)
  restricts supersession and license inheritance to listed versions.
- The deployed
  [serializer](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/addons/serializers.py)
  supports source-on-create and assigning a missing custom license afterward.
  Review locks apply to source changes, not this missing-license assignment.
  The [published v5 contract](https://mozilla.github.io/addons-server/topics/api/addons.html)
  documents these author-only operations.
- Deployed unlisted approval signs/approves the file without requiring a public
  listing. Thus this path uses authenticated version status and final source,
  license, signed hash and size checks. The listed anonymous verifier is retained
  unchanged for normal releases.

## Operation and recovery

Use an isolated checkout of the **merged release PR commit**, with the locked
dependencies and Firefox 156 available. Do not change or move its protected tag.
Wait for that main commit's CI to succeed. Run the standard build and temporary
package verification to bind the unsigned input, then the one-off command:

```sh
nix develop
npm ci --ignore-scripts
node scripts/build.js
node scripts/package-test.js --output=artifacts/ci/package.json
nix develop .#release --no-update-lock-file --command \
  node --env-file=/absolute/path/to/ignored/.env scripts/release/unlisted.js \
  --tag=v1.1.6 --pull-request=MERGED_PR_NUMBER
```

The inner release shell supplies the locked GitHub CLI while retaining the outer
development shell's browser/build tools. The command checks CLI availability
before creating a tag or submitting anything.

The environment needs the authorized operator's `GITHUB_TOKEN` (or `GH_TOKEN`)
and existing `JWT_ISSUER`/`JWT_SECRET` (or `AMO_JWT_ISSUER`/`AMO_JWT_SECRET`).
Credentials are never arguments, archive members or evidence contents. This
manual session already holds both provider credentials; no Actions secret or
workflow permission is broadened. Coordinate with other publishers and Developer
Hub editors. The command refuses active hosted publishers and locks all local
worktrees through the repository's common Git directory. It cannot lock another
maintainer's independent clone or a manual Developer Hub action.

A wait lasting 15 minutes returns a verified `awaiting-review` state. The
secretless listed scheduler cannot see unlisted approvals. For this one-off
release, rerun the same command from the same frozen source after approval; it
reconciles instead of blindly repeating writes. `artifacts/unlisted-status.json`
records the signing outcome; `artifacts/release-publication.json` records verified
immutable publication. A failed process leaves
remote objects intact. A stale `.git/stackma-unlisted.lock` requires checking that
the recorded process and all provider requests have finished before removing
that local lock. A timeout alone does not establish provider cancellation.

If the version is rejected/disabled, inspect Mozilla's message; do not re-enable,
delete or resubmit it automatically. If a draft/asset/tag/license/source conflicts,
preserve the state and investigate. An interrupted final verification reruns native
attestation checks against the existing immutable publication. The successful
1.1.6 result is recorded above; it does not certify future submissions.
