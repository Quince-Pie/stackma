# Applying the release recommendation to Stackma

Reviewed 2026-09-24 against `6611e237beb647e400262a0d030030858c36990b` and
the supplied `/tmp/RELEASE-RECOMMENDATION.md`. Its content digest and this change's
verification are recorded in [the evidence](../evidence/release/policy-review.json).
The 45-minute total budget began at 03:47:48 UTC and includes the interrupted
incident investigation, recommendation review, implementation, testing and the
license question. The recommendation was evidence, not authority to change
remote settings, publish, delete tags/releases, or schedule recurring work.

## Assessment

The recommendation is a sound reference policy with explicit limits. It correctly
separates source approval, artifact identity, publication, channels and recovery.
It does not supply a tested Firefox pipeline, establish a performance winner, or
claim universal perfection. Its applicable principles are worth using; adopting
all named technologies would not establish their guarantees for this extension.

The review covers the claims that affect Stackma's design: GitHub release
immutability and attestations, workflow/event authority, controlled builds,
version ordering, Mozilla signing and distribution, and recovery. It is not an
exhaustive certification of the report's unrelated language, registry or product
examples. Existing [publication](release-qualification.md) and
[preparation](release-preparation.md) source comparisons remain applicable to
their unchanged mechanisms. No new scheduler, build engine or version bot is
selected by these diagnostic/UI corrections, and no speed claim is made.

| Recommendation | Application and supported limit |
| --- | --- |
| Reviewed release intent | Preserve the explicit version PR and human merge policy. Resolve and test the actual integrated commit, including squash/rebase and merge-group cases. |
| Verify the installed deliverable | Preserve unsigned package installation, exact signed-payload comparison and permanent Firefox signature/behavior checks. Mozilla signing changes the wrapper; unsigned and final signed digests remain distinct. |
| Immutable, complete artifact set | Preserve the explicit source ZIP, signed XPI, release record and checksums. The workflow completes a draft before publishing and verifies every release asset against GitHub's native attestation. |
| Recover interrupted publication | Preserve exact-version lookup, content/license/source checks, no overwrite, bounded retries and an explicit Latest policy. GitHub and AMO are separate publication operations. |
| Clear maintainer interface | Corrected: **Release** prepares the PR; **Publish release** runs after merge or resumes an existing prepared tag. New-release users no longer start at the existing-tag publisher. |
| Follow the actual ecosystem's version rules | Corrected the Chrome-only 16-bit cap. AMO supports up to nine digits per component. The existing three-component stable release format stays in place. |
| Short-lived publication authority | GitHub uses job-scoped `GITHUB_TOKEN`. AMO currently uses an issuer/secret to mint JWTs; the secret itself is long-lived. It must remain in `release-signing`, with its owner responsible for rotation. An npm OIDC/stage-only recipe does not configure AMO. |
| Independently controlled authorization | Named jobs/environments alone are not independent approval. The current policy uses human source merge plus any configured environment reviewers. Read-only inspection found no environments configured at the time of review; the release guide contains the required setup. No two-party-review claim is made. |
| SLSA provenance, SBOMs and independent rebuilding | Useful for additional specified threats, but not present merely because a GitHub release is immutable. This pipeline does not claim SLSA conformance, an SBOM, or independent rebuild verification. Adding an attestation step alone would not establish build isolation or defeat a compromised release authority. |
| TUF/custom update protocol | The listed add-on receives updates through Firefox/AMO. Stackma owns no custom updater to replace with TUF. No new distribution channel is introduced. |
| Rehearsed recovery and consumer verification | Local fault tests exist, including lost writes, conflicts, older-version completion, invalid source and unsigned installation. The complete hosted AMO/GitHub success path and account/key-rotation recovery remain unverified. |

The material trust assumptions remain GitHub's enforcement, Mozilla's signing and
review, authorized maintainers, and the reviewed tool/dependency sources. A
compromised authorized maintainer or forge is not addressed by an independently
administered trust root here. Repository policy and environment configuration are
owned by the repository administrator; no protection bypass is introduced.

## Primary-source checks and consequences

- GitHub's current [immutability documentation](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
  confirms that release assets and tags are locked after publication. A deleted
  immutable release's tag name cannot be reused. Titles, notes and Latest remain
  mutable, so they are not the immutable inventory. This matters directly to the
  `v1.1.1` incident below.
- [GitHub CLI attestation verification](https://cli.github.com/manual/gh_attestation_verify)
  supports the report's signer/source restrictions and warns that workflow-owned
  predicates can be forged by a compromised execution. The existing
  [release-asset verification](https://cli.github.com/manual/gh_release_verify-asset)
  establishes release membership and bytes; it does not substitute for trusted
  build provenance. The example `gh attestation verify` command needs actual
  generated provenance and policy-owned expected identities before adoption.
- [SLSA 1.2 build requirements](https://slsa.dev/spec/v1.2/build-requirements)
  distinguish provenance authenticity, resistance to forgery and isolation.
  Repeated equal builds in the same trust domain do not independently establish
  those properties. No SLSA level is inferred from our workflow job names.
- The September 2026 [execution-protection changelog](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/)
  supports workflow-specific actor/event restrictions. They require repository
  policy configuration; YAML alone does not activate them. Our publisher keeps
  its merged, same-repository PR/main checks and no `pull_request_target` trigger.
  The [cache-mode change](https://github.blog/changelog/2026-09-10-control-github-actions-cache-access-with-cache-mode/)
  is relevant when an Actions cache is used; these workflows have none, so no
  cache workflow or permission is added simply to use that feature.
- Mozilla's [signing/distribution documentation](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
  confirms that listed submissions may become available through AMO and that
  Firefox manages their updates. A later GitHub approval cannot retract AMO
  availability. The approval boundary for submission is `release-signing`.
  The current [authentication API](https://mozilla.github.io/addons-server/topics/api/auth.html)
  uses JWT credentials; npm staged publishing is a different service protocol.
- [MDN's version documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/version)
  explicitly distinguishes AMO's nine-digit limit from Chrome's 65535 cap.
  The supplied Firefox source at `9e9b5f17f56187c1f5c8b9cdf79a01ff51a7b643`,
  `Schemas.sys.mjs:1386`, and the installed Mozilla linter's
  `isValidVersionString` use the nine-digit rule. The MDN checkout is
  `8530cf97b809705c3524e733afcb69124b305b2e`. Earlier reports describing 65535 as a
  Firefox requirement were wrong; the current guide and validator correct this.

## Incident, changes and checks

Read-only GitHub inspection found `v1.1.1` at `6611e23`, with four `1.1.0`
version declarations. Release `395301544` was already published, immutable and
empty. Run `35952833704` failed at source resolution; CI, tag creation, AMO signing
and GitHub publication were skipped. There was no preparation run or release PR.
The identity check correctly blocked inconsistent source; the operator interface
and error message failed to explain the recovery clearly.

The corrected interface makes **Release** the normal PR-preparation entry point
and **Publish release** the automatic/advanced publisher. Filenames, dispatch
input keys, the PR merge authority, credentials, artifact flow and tag-preserving
behavior are unchanged. Version mismatch reports now list all four declarations,
identify the source commit and explain preparation and immutable-tag recovery in
both an Actions error annotation and the run summary. Failure remains nonzero
and emits no release outputs. Annotation data is escaped.

Use a fresh version, currently **`v1.1.2`**. Its GitHub tag was absent, and owner
GETs for Mozilla versions `1.1.1` and `1.1.2` returned no existing version. These
are observations at inspection time, not reservations. No remote write or deletion
was performed, and no submitted version was altered.

The new CLI regression reproduces the exact error with a real local tag pointing
to old version metadata and verifies the failure status, summary, lack of outputs
and preserved tag. Unit tests cover field diagnostics and AMO's numeric bounds.
`scripts/release/check-version-format.js` checks `65536.0.0` and
`999999999.999999999.999999999` using Mozilla lint and actual temporary Firefox
156 XPI installations, then reads the complete versions back. CI runs that check.
It uses only tracked extension files, an isolated profile and cleaned temporary
files; it neither signs nor submits its probe packages.

Reproduce inside `nix develop`:

```sh
npm run test:release
node scripts/ci/check-workflows.js
zizmor --offline --persona=pedantic .github/workflows
node scripts/release/check-version-format.js
```

The evidence records actual results and source hashes. Local verification is not
a successful hosted release, and no universal optimality or measured usability
superiority is claimed. The first authorized complete run must still validate
environment configuration, PR/merge events, Mozilla approval, signed installation
and immutable publication together.

## License clarification

Both project license copies match. Their opening copyright statement names
Quince Pie; Sam Hocevar's notice belongs to the WTFPL license document itself.
This follows the official [WTFPL FAQ's application guidance](https://www.wtfpl.net/faq/)
and the [Choose a License text](https://choosealicense.com/licenses/wtfpl/).
The separate CMU notice is preserved byte for byte in the packaged copy. No
license edits were needed or made.
