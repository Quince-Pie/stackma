# Releasing Stackma

> Historical operator guide, preserved with all working-tree edits supplied to
> the 2026-09-26 redesign. Its implementation descriptions are superseded by
> [the current release guide](releases.md) and [design qualification](release-design.md).

The **Release** workflow (`prepare-release.yml`) creates a version-update PR.
Merging that PR starts **Publish release** (`release.yml`), which submits a stable
version to the existing **listed**
[Stackma add-on](https://addons.mozilla.org/firefox/addon/stackma/). If Mozilla
approves it within the signing job's wait, the same run verifies the signed package
in Firefox 156 and publishes an immutable GitHub Release. Otherwise the run ends
successfully in the **awaiting review** state, and **Resume approved releases**
(`resume-release.yml`) starts publication after approval. Ordinary pushes,
unrelated PRs and CI builds do not release anything. You choose the version;
commit messages do not choose it.

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
5. Protect release identity. A tag ruleset for `refs/tags/v*` blocks deleting or
   moving release tags, including tags whose version still awaits Mozilla review.
   Tag creation stays open because **Publish release** creates each tag with
   `GITHUB_TOKEN`. A ruleset for the default branch blocks force pushes and
   deletion, which would orphan released commits; ordinary pushes stay allowed.

`scripts/release/repository-policy.js` checks steps 1, 2 (deployment branches),
4 and 5 without changing anything, and exits nonzero if something differs. With
`--apply` it makes the missing changes and checks again. It needs a repository
administrator's token, from `GH_TOKEN` or `gh auth login`:

```sh
nix develop .#release
gh auth login
node scripts/release/repository-policy.js           # check only
node scripts/release/repository-policy.js --apply   # create or update
```

It never deletes anything. It keeps environment reviewers and wait timers and any
extra rules added to its two rulesets, except a tag creation rule, which would
stop **Publish release** from creating tags. It also reports any other active
ruleset that restricts creating `v*` tags or `release/v*` branches, because
`GITHUB_TOKEN` cannot bypass rulesets on a user-owned repository. Those rulesets
and extra deployment branch policies are reported for manual removal. Secrets
(step 3) are not read or written.

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
   enter a new version, for example **`v1.1.5`**. This is `prepare-release.yml`.
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
4. If Mozilla has not approved the version after about 15 minutes, the run ends
   successfully with an **Awaiting Mozilla review** summary and publishes nothing
   on GitHub. Nothing else is required: **Resume approved releases** checks every
   6 hours and runs **Publish release** for the tag once Mozilla has approved it.
   To publish sooner after approval, run **Publish release** with the tag yourself.
   Existing submissions and matching assets are reconciled, never resubmitted.

The CLI equivalent of step 1 is:

```sh
gh workflow run prepare-release.yml --ref main -f version=v1.1.5
```

**Publish release → Run workflow** remains available for an **existing prepared** tag, for example
to resume publication. Entering a new version there does not prepare it. A missing
tag now produces instructions to use **Release** (`prepare-release.yml`), instead of Git's
`fatal: Needed a single revision` error. If verification failed before the tag was
created, rerun the original merged-PR run, which retains authority to create it.

Wait for Mozilla's decision on a submitted version before merging the next release
PR. When AMO creates a listed version, it disables every older listed version still
awaiting review (`Version.disable_old_files()` in addons-server). The signing job
therefore refuses to create a version while another listed version awaits review.
It stops before creating anything, normally before uploading, and its summary
explains both ways forward: wait for
the decision and rerun, or deliberately replace the pending version by running
**Publish release** with the new tag and that pending version in **supersede**.
The tag created before that stop remains and is reused by the rerun. The check is
part of the signer, which runs from each release commit: tags created before this
change have no check, but `v1.1.2` to `v1.1.4` already exist on AMO, so none of
them creates a version.

Prepare one version at a time. A repeat
preparation reuses the exact existing PR without resetting its branch. An observed
manual edit, closed PR, duplicate PR history, or conflicting tag stops preparation
for explicit resolution. To abandon a version, close its PR; it will not release.
Do not reuse that version's reserved branch for unrelated work. The workflow does
not automatically delete branches; GitHub's optional delete-after-merge setting
works because release uses the event's merge commit, not the remaining branch.

On 2026-09-26, a read-only owner query showed the listing still **nominated**:
Mozilla has not yet approved any Stackma version. Version **1.1.4** awaits review
with its source attached. Versions 1.1.0, 1.1.2 and 1.1.3 are disabled because
each later submission disabled the pending one before it. The `v1.1.2` and
`v1.1.3` tags therefore have no AMO or GitHub release and remain as history.
A first listing needs human review, and AMO also delays automatic approval of a
nominated add-on's new version by 24 hours (`INITIAL_AUTO_APPROVAL_DELAY_FOR_LISTED`),
so the first release always outlasts the signing job's wait.

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

Before creating a version, the signer lists every listed version through the
owner-only `all_without_unlisted` filter, following pagination within the AMO API
for at most 20 pages. Any listed version other than the target in the
`unreviewed` file state blocks creation unless **supersede** names exactly that
single version. The check runs before the upload and again immediately before
creation. Unreadable or unexpected listing entries fail closed. Resuming an
existing version never lists or disables other versions.

The signer stops waiting for approval 15 minutes after signing starts, inside its
20-minute network deadline. It reports **awaiting review** only after the version exists,
its payload, channel and license match, and its source archive is attached and
verified. That step sets the `state` output, and later steps and the publication
job skip only for exactly `awaiting-review`. The sign job runs the signer from the
release commit, and signers from before this state set no output and succeed only
after approval, so those tags still publish normally.

**Resume approved releases** runs every 6 hours with only `contents: read` and
`actions: write`, and no secrets. It lists stable `v*` tags without a published
GitHub release and asks the public AMO API, without credentials, whether the
listing and each version are approved. It dispatches **Publish release** on
`main` for the oldest such tag, at most one per run, and never while a Publish
release run is queued, running or waiting. It counts a tag's automatic attempts
by who started each run, so rerunning one does not reset the count. After two
automatic attempts without a published release, it stops dispatching that tag and
fails on every scheduled run until the tag is published. Failed runs started by
`github-actions[bot]` notify nobody, but a failed scheduled run notifies the user
who last changed the workflow's schedule.

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
| Mozilla has not approved the version within the 15-minute wait | The run succeeds with an **Awaiting Mozilla review** summary and no GitHub publication. The AMO version and source remain. **Resume approved releases** starts publication after approval, or run **Publish release** with the tag. |
| Another listed version awaits review when a new version would be created | Signing fails before creating a version, normally before uploading, and the summary gives both options. Wait for Mozilla's decision and rerun, or run **Publish release** with the new tag and **supersede** set to the pending version. |
| Publication after approval fails | After two automatic attempts for a tag, **Resume approved releases** stops dispatching it and fails on each scheduled run, which notifies the user who last changed its schedule. Fix the cause, then rerun the failed **Publish release** run. |
| GitHub disabled the scheduled workflow after 60 days without repository activity | Enable **Resume approved releases** again under **Actions**, or run **Publish release** with the tag. |
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
verification, and 20 for publication. **Resume approved releases** has 15 minutes
and checks at most the 20 newest unpublished tags per run, reporting any excess.
Queue/approval waiting time is separate.
Network calls, archive reads and child processes have additional
deadlines. Downloads are bounded at AMO's 200 MB archive/source limit. ZIP members
are streamed with expected-size checks, rather than expanded into an unbounded
buffer. GitHub history recovery is bounded at 10,000 releases and 16 nested tag
objects; reaching a bound fails closed without assuming absence.

Unsigned input artifacts expire after 14 days; verified signed artifacts after
30 days. GitHub Releases persist. A dispatch after approval builds fresh inputs,
so input expiry does not block it. Such a run uses `main`'s workflow, resolution,
tagging and publication scripts, and the release commit's CI, signing and package
verification scripts. Jobs therefore skip only on the explicit `awaiting-review`
state, which older signers never set. A workflow change on `main` that calls a
script missing from an older tag would still fail for that tag. Once approved,
Firefox obtains updates through the existing AMO listing; no custom update URL or
alternate add-on ID is introduced.

## Local verification

Inside `nix develop`:

```sh
npm ci --ignore-scripts
npm run check
npm run test:ci
npm run test:release
node scripts/ci/check-workflows.js
zizmor --offline --persona=pedantic .github/workflows
node scripts/release/resume.js --dry-run --repository=Quince-Pie/stackma
npm run build
npm run test:package -- --output=artifacts/local-package.json
```

The ordinary package command uses temporary installation. The release gate uses:

```sh
node scripts/package-test.js --signed --xpi=path/to/signed.xpi --output=artifacts/signed-package.json
```

See [preparation design and verification](release-preparation.md),
[the release-policy review and corrections](release-policy-review.md),
[the publication qualification](release-qualification.md),
[Mozilla review handling](amo-review.md) and
[verification evidence](../evidence/release/validation.json). Hosted runs have
since submitted versions 1.1.2 to 1.1.4 to AMO, attaching source to the last two.
Mozilla approval, permanent installation of a Mozilla-signed package, immutable
GitHub publication and an automatic resumption have not happened yet. The first
approved release must establish those acceptance gates before claiming production
end-to-end verification.
