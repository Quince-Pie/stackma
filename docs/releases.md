# Releasing Stackma

The **Release** workflow (`prepare-release.yml`) creates a version-update PR.
Merging that PR starts **Publish release** (`release.yml`), which submits a stable
version to the existing **listed**
[Stackma add-on](https://addons.mozilla.org/firefox/addon/stackma/), waits for
Mozilla approval, verifies the signed package in Firefox 156, and publishes an
immutable GitHub Release. Ordinary pushes, unrelated PRs and CI builds do not
release anything. You choose the version; commit messages do not choose it.

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
4. Under **Settings → Actions → General → Workflow permissions**, enable
   **Allow GitHub Actions to create and approve pull requests**. Preparation
   needs permission to create PRs; it never approves or merges them. Branch/tag
   rules must permit creation of `release/v*` branches and `v*` tags by the
   workflow. No protection bypass or force push is used.

GitHub now allows bot-created PRs to run CI with collaborator approval. If the PR
shows **Approve and run**, approve that run and wait for the checks before merging.
This uses the built-in token; adding a PAT solely to trigger PR CI is unnecessary.
See [GitHub's June 2026 change](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/).

Do not simultaneously edit the same version's source/license in the Mozilla
Developer Hub or publish the same GitHub release through another client. This
workflow serializes its runs, but neither service offers a transaction spanning
the other service or an atomic “attach source only if still empty” operation.

## Make a release

1. Make sure the intended source and these workflows are committed and pushed to
   `main`. In **Actions → Release → Run workflow**, select **main** and
   enter a new version, for example **`v1.1.3`**. This is `prepare-release.yml`.
   **Do not create a tag or use GitHub's Releases → Draft a new release page.**
   The workflow creates the tag and GitHub Release at the appropriate stages.
2. Open the PR linked in the run summary. It updates the manifest, package version,
   and both root versions in the lockfile. Dependencies and the add-on ID stay the
   same. Approve CI if requested, review the PR, and merge it after checks pass.
   Merge, squash and rebase merges are supported. Merging authorizes release.
3. **Publish release** starts automatically for the merged release PR. It verifies the
   exact merged commit, creates the matching tag after CI passes, and continues
   through Mozilla signing and GitHub publication. Complete any environment
   approvals configured in your repository.
4. If Mozilla needs more review time, wait for approval and **rerun the original
   Publish release run**. Existing submissions and matching assets are reconciled.

The CLI equivalent of step 1 is:

```sh
gh workflow run prepare-release.yml --ref main -f version=v1.1.3
```

**Publish release → Run workflow** remains available for an **existing prepared** tag, for example
to resume publication. Entering a new version there does not prepare it. A missing
tag now produces instructions to use **Release** (`prepare-release.yml`), instead of Git's
`fatal: Needed a single revision` error. If verification failed before the tag was
created, rerun the original merged-PR run, which retains authority to create it.

Prepare one version at a time, merging its PR before preparing the next. A repeat
preparation reuses the exact existing PR without resetting its branch. An observed
manual edit, closed PR, duplicate PR history, or conflicting tag stops preparation
for explicit resolution. To abandon a version, close its PR; it will not release.
Do not reuse that version's reserved branch for unrelated work. The workflow does
not automatically delete branches; GitHub's optional delete-after-merge setting
works because release uses the event's merge commit, not the remaining branch.

On 2026-09-24, read-only authenticated checks confirmed that **1.1.0** was already
listed and awaiting review, with custom WTFPL metadata. Its uploaded package
lacks the later project `LICENSE` file and has differently formatted manifest
bytes. The current repository therefore cannot be released over that submission.
Use a new version for the current source; the workflow refuses conflicting 1.1.0
contents instead of replacing the pending version. No submission was changed
during development of this workflow.

## What the workflow verifies

Preparation computes an expected Git tree in an isolated index using only three
committed JSON files. It preserves every other tracked file and leaves local work
untouched. GitHub's returned tree must match. Ref creation uses create-if-absent;
an existing branch or tag is never moved. Preparation uses no Mozilla credentials.

The read-only resolution job validates a merged, same-repository release PR on
`main`, or resolves an existing manual tag, and reuses CI at that exact checkout.
Automatic releases require a version increase over the recorded preparation
base, which must remain in the merged history. This also permits a merge queue
to include later non-version commits. A separate write job creates/reconciles the
tag only after CI passes.
Tag, manifest and npm versions must agree. Versions use
three canonical numeric components, each at most 999999999 (AMO's nine-digit
limit, not the Chrome Web Store's 65535 limit). Firefox 156 and the
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

### The v1.1.2 AMO format failure

Mozilla accepted version `1.1.2`, but returned its license as HTML and normalized
the manifest's JSON encoding. Those transformations exposed two invalid
assumptions in our checks. The [AMO format correction](amo-formats.md) documents
the provider code, fixes and verification.

Use a new **`v1.1.3`** release after pushing the fixes. Keep the existing `v1.1.2`
tag and submission intact. The release still uses the code at its own tag;
there is no separate recovery controller or automatic license rewrite.
The license parser verifies the complete plain text and link destinations.
`license.sha256` identifies the submitted text; `license.apiSha256` identifies
the verified API HTML and is checked again before GitHub publication.

The manifest now uses ASCII JSON escapes, two-space indentation and no final
newline, matching AMO's normalizer for this manifest. Preparation preserves that
encoding. JSON values and Firefox UI strings are unchanged. ZIP verification
still requires every original member to match exactly, including the manifest.

### The accidentally published v1.1.1

The manually published [v1.1.1 release](https://github.com/Quince-Pie/stackma/releases/tag/v1.1.1)
is immutable, has no uploaded assets, and points to `6611e23`, whose manifest and
npm versions are still `1.1.0`. The failed workflow stopped during resolution;
its CI, tagging, Mozilla submission and publication jobs were skipped. Renaming a
tag does not update the versions inside its source.

Use **`v1.1.2`** through **Release** (`prepare-release.yml`) for the correction.
GitHub [does not permit reuse of an immutable release's tag name, even after deletion](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
Leave `v1.1.1` in place; deleting or moving it is not part of this recovery.
There is no need to create a replacement release page manually.

The workflow used to display preparation as **Prepare release** and publication
as **Release**. Those names made the wrong entry point look like the normal way
to start. The current names put new-release preparation under **Release**, with
the advanced existing-tag path under **Publish release**. The workflow filenames
are unchanged, so CLI commands using the filenames retain their meaning.

| Condition | Result and recovery |
| --- | --- |
| Preparation loses a response after creating a branch or PR | Rerun **Release** (`prepare-release.yml`) for the same version. It reads existing state and reuses exact matches. |
| Preparation creates a branch but PR permission is missing | Enable Actions PR creation, then rerun preparation. The existing branch is preserved. |
| Release PR is closed without merging | No release. Reopen it explicitly to resume; preparation does not reopen it. |
| Tag creation succeeds but its response is lost | Rerun the original **Publish release** run. The tag must match the verified commit. |
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

Preparation and publication have separate queues, each retaining up to 100 pending
runs without canceling active work. Job runtime limits are 10 minutes each for
preparation, resolution and tag creation, 20 for CI, 35 for signing/browser
verification, and 20 for publication. Queue/approval waiting time is separate.
Network calls, archive reads and child processes have additional
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

See [preparation design and verification](release-preparation.md),
[the release-policy review and corrections](release-policy-review.md),
[the publication qualification](release-qualification.md) and
[verification evidence](../evidence/release/validation.json). Code, local tests,
negative signature enforcement and read-only production AMO inspection are
verified. A real AMO mutation/approval, GitHub-hosted release run, and immutable
publication have not been performed as part of this implementation. The first
authorized release must establish those service acceptance gates before claiming
production end-to-end verification.
