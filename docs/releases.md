# Releasing Stackma

The **Release** workflow submits a stable version to the existing **listed**
[Stackma add-on](https://addons.mozilla.org/firefox/addon/stackma/), waits for
Mozilla approval, verifies the signed package in Firefox 156, and publishes an
immutable GitHub Release. Normal pushes and CI builds do not release anything.

## One-time GitHub setup

1. Enable **immutable releases** in the repository's release settings **before
   the first publication**. The normal workflow token cannot read this
   administrative setting. The workflow checks the published release and its
   attestations, but that check cannot undo a publication under a wrong setting.
2. Create environments named `release-signing` and `release-publication`. Restrict
   deployment branches to `main`. Add environment reviewers if you want a second
   person to authorize submission/publication.
3. In `release-signing`, create these environment secrets:

   | GitHub secret | Local `.env` entry |
   | --- | --- |
   | `AMO_JWT_ISSUER` | `JWT_ISSUER` |
   | `AMO_JWT_SECRET` | `JWT_SECRET` |

   The workflow reads GitHub secrets; it does not read or upload `.env`. Local
   environment files are ignored by Git. Keep `.env` out of commits. No GitHub
   PAT, AMO password, additional signing certificate, or npm publishing token is
   required. Publication uses the job's short-lived `GITHUB_TOKEN`.

Do not simultaneously edit the same version's source/license in the Mozilla
Developer Hub or publish the same GitHub release through another client. This
workflow serializes its runs, but neither service offers a transaction spanning
the other service or an atomic “attach source only if still empty” operation.

## Make a release

1. Choose a new stable `MAJOR.MINOR.PATCH` version. Set it in
   `extension/manifest.json` and `package.json`; update `package-lock.json` with
   `npm install --package-lock-only --ignore-scripts`. Keep the existing add-on ID.
2. Commit the intended source and release automation on `main`. Run the checks
   described below. Create and push the matching tag, for example `v1.1.1`.
   Tags must already exist and point into the `main` history selected for dispatch.
3. In GitHub **Actions → Release → Run workflow**, select branch **main** and enter
   the tag. The workflow never invents a tag, bumps a version, or changes a listing.
4. If Mozilla needs more review time, wait for approval and **rerun the original
   workflow run**. The workflow reconciles the existing version and draft assets.

On 2026-09-24, read-only authenticated checks confirmed that **1.1.0** was already
listed and awaiting review, with custom WTFPL metadata. Its uploaded package
lacks the later project `LICENSE` file and has differently formatted manifest
bytes. The current repository therefore cannot be released over that submission.
Use a new version for the current source; the workflow refuses conflicting 1.1.0
contents instead of replacing the pending version. No submission was changed
during development of this workflow.

## What the workflow verifies

The read-only job resolves the tag to a commit and reuses the existing CI workflow
at that exact checkout. Tag, manifest and npm versions must agree. Versions use
three canonical numeric components, each at most 65535. Firefox 156 and the
existing `stackma@extensions.local` identity remain fixed requirements.

CI performs the source, catalog, installer, release-policy and browser checks,
compares two unsigned builds, and installs that unsigned XPI temporarily. Staging
requires the same XPI digest as the successful package test. It rejects untracked
payload files and archives only committed source. Git, Node and the release tools
come from the same locked Nix input. The source archive is generated in UTC.

The signing job gets that run's exact artifact ID. It reads AMO's maintenance
state and the existing listing, then queries the exact version. Only a version
404 permits creation; authorization and server errors do not. Existing versions
must match the intended payload, channel, license text and source archive. New
versions receive explicit custom license metadata retaining both the WTFPL grant
and CMU conditions. Existing license metadata is never rewritten.

Mozilla's SHA-256 and size are checked against the downloaded archive. Every
original member's name, size and SHA-256 must match the tested unsigned payload;
duplicate names, path aliases, changed local/central names, CRC errors and extra
code are rejected. Only the five known Mozilla signature files and their optional
directory are additions. This content comparison is separate from cryptographic
verification: a **permanent** Firefox installation must report Mozilla's signed
state and run the existing grouping/naming package check. An unsigned XPI fails.

For listed releases, both the exact version and the listing must be approved and
enabled. The publication job checks public AMO eligibility again after any
environment approval delay. It receives no AMO credentials. The signed artifact,
readable source ZIP, `release.json` and `SHA256SUMS` are attached to a draft with a
build identity marker. Existing assets must match by name, size and SHA-256;
uploads and publication target the validated numeric release ID. No clobber or
automatic deletion is used. Publication happens only after every asset is present.
GitHub's immutable release attestation is then verified against every local asset.

The release attestation establishes GitHub release/asset identity. It is not a
claim of SLSA build provenance, independent approval of the code, or proof of
universal optimality.

## Recovery and limits

| Condition | Result and recovery |
| --- | --- |
| AMO review exceeds the 20-minute polling budget | No GitHub publication. The AMO version/source remain available. Rerun after review. |
| Submission response is lost | Fail without repeating the write. Rerun queries the version before submitting anything. |
| Same version has different code, license or source | Fail without replacing it. Choose a new version or resolve the discrepancy explicitly. |
| Tag moves while work or approval is pending | Stop at the next tag check, including checks before AMO writes and GitHub publication. Restore the intended tag through normal repository policy before retrying. |
| Upload finishes but its response is lost | Rerun accepts the matching asset and uploads only missing assets. |
| A draft asset is incomplete or has different bytes | Stop and preserve the draft. Inspect it; cleanup is an explicit owner action. |
| Duplicate drafts or unexpected assets | Stop; do not select or delete one automatically. |
| Publication succeeds but attestation is delayed | Retry verification a bounded number of times. If still unavailable, retain the published release and rerun verification. |
| Published release is mutable | Fail the final gate and preserve it. Enabling immutability later does not retroactively freeze that release; owner intervention/new release is needed. |
| An older approved version is recovered after a newer release | Keep the newer release as Latest. |

AMO and GitHub publication are separate operations. AMO can approve and publish
the listed version even if a later GitHub step fails. There is no rollback of that
approval, no cross-service atomic transaction, and no atomic lock tying a tag check
to a later service write. Coordinated publishing and protected tags are material
operating assumptions. Checks detect observed conflicts; they cannot prevent all
concurrent administrative changes after a check.

Runs queue without canceling an in-progress release; GitHub retains up to 100
pending runs. Job runtime limits are 5 minutes for resolution, 20 for CI, 35 for
signing/browser verification, and 20 for publication. Queue/approval waiting time
is separate. Network calls, archive reads and child processes have additional
deadlines. Downloads are bounded at AMO's 200 MB archive/source limit. ZIP members
are streamed with expected-size checks, rather than expanded into an unbounded
buffer. GitHub history recovery is bounded at 10,000 releases and 16 nested tag
objects; reaching a bound fails closed without assuming absence.

Unsigned input artifacts expire after 14 days; verified signed artifacts after
30 days. GitHub Releases persist. Prefer rerunning the original workflow to retain
its tooling revision. A new dispatch on newer `main` can require scripts absent
from an older tag. Once approved, Firefox obtains updates through the existing
AMO listing; no custom update URL or alternate add-on ID is introduced.

## Local verification

Inside `nix develop`:

```sh
npm ci --ignore-scripts
npm run check
npm run test:ci
npm run test:release
node scripts/ci/check-workflows.js
zizmor --offline --persona=pedantic .github/workflows
npm run build
npm run test:package -- --output=artifacts/local-package.json
```

The ordinary package command uses temporary installation. The release gate uses:

```sh
node scripts/package-test.js --signed --xpi=path/to/signed.xpi --output=artifacts/signed-package.json
```

See [the source and design qualification](release-qualification.md) and
[verification evidence](../evidence/release/validation.json). Code, local tests,
negative signature enforcement and read-only production AMO inspection are
verified. A real AMO mutation/approval, GitHub-hosted release run, and immutable
publication have not been performed as part of this implementation. The first
authorized release must establish those service acceptance gates before claiming
production end-to-end verification.
