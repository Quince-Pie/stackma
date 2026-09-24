# Release-flow qualification

The original publication qualification below remains the record for signing and
publication. [Release preparation](release-preparation.md) supersedes its manual
version/tag initiation policy: the user selected an explicit version PR followed
by release after merge. It revisits the previously omitted release/version bots.
The later [policy review](release-policy-review.md) corrects the version-component
limit and makes preparation the primary **Release** entry point.

Reviewed 2026-09-24 against baseline `2a73512`. Scope: GitHub.com, hosted Ubuntu
24.04 x86-64, the existing listed Stackma add-on, stable version tags, and Firefox
156. Implementing the workflow did not authorize publishing, modifying the pending
AMO submission, configuring remote secrets, moving tags, pushing or committing
this work. The user supplied Mozilla credentials for context; only read-only
requests were made, and credential values were not printed or included in source.
The pre-existing `extension/icon.png` was preserved separately from this work.

An 85-minute total budget began at 00:42:06 UTC, including source/changelog review,
bounded independent reviews, implementation, integration checks and final review.
The original baseline and source snapshots are retained under
`artifacts/release-audit/`. Final evidence records the actual completed scope.

## Contract and selection

Feasibility gates are the exact tested payload, stable identity/version agreement,
explicit release initiation, least required credentials per job, correct error
propagation, bounded waiting and recoverable partial service state. Existing
versions and observed conflicting assets must not be silently replaced. Browser
support, grouping behavior, manual group metadata and naming remain unchanged.

Among feasible designs, prefer one CI verification path, maintained primary API
mechanisms, no redundant runtime resolver, bounded memory/transfers, and explicit
ownership of writes. Relevant costs are CI jobs, tool/dependency state, archive
bytes, service calls and review burden. No workload frequencies, latency targets,
weights, confidence intervals or empirical speed claims were invented. This is
an occasional release workflow, not a tab-grouping hot-path optimization.

The evidence supports this scoped selection, with the operating prerequisites and
live-service acceptance gap in [the release guide](releases.md). It establishes
neither universal dominance nor fully exercised production publication.

## Primary mechanisms and alternatives

| Candidate | Decisive mechanism and disposition |
| --- | --- |
| Plain current `web-ext sign` | Maintained conventional control, but rebuilds its own XPI and always submits a version. Its upload UUID cache does not recover an already-created version after approval timeout. Does not meet this recovery contract alone. |
| Pinned Mozilla submission client plus a small coordinator | Selected. Reuses the exact multipart upload and version-creation implementations, accepts the pretested XPI, and adds version lookup, explicit source/license checks and bounded transport. Its internal module is a deliberate maintenance dependency covered by protocol tests. |
| Entire custom AMO REST/JWT client | Could implement the same state machine, but duplicates maintained request/authentication construction without a required capability. The selected adapter replaces only the deficient transport/polling/recovery boundaries. |
| Multipart version POST with source attached during creation | Investigated as a stronger source-attachment mechanism. Current v5 cannot combine multipart source with `custom_license`; it can inherit the preceding license. That conditional path saves a request only when inherited terms already match, shares the preceding custom-license object, and adds a second creation policy. The delivered path deliberately gives every version its own explicit terms, including the current license migration; it retains the documented source-attachment boundary instead of adding implicit inheritance. |
| Official GitHub CLI with explicit draft and ID-bound REST writes | Selected. Preserves drafts after partial failures, verifies all existing asset digests, and uses native release attestations. REST uploads/PATCH bind the already-validated numeric release ID rather than re-resolving a tag for each write. |
| `softprops/action-gh-release` 3.0.3 | Credible maintained alternative; v3 uses Node 24 and improves draft/retry handling. Its bounded two-page fallback and same-name skipping with `overwrite_files: false` do not prove unique draft ownership or identical asset contents. It still needs this coordinator's checks; adding its execution dependency does not remove them. |
| Automatic release/version bots | Do not decide Mozilla review completion, pending-version identity, or credential separation. Omitted because the requested flow uses explicit stable tags and human release intent, with no authorized commit-message-to-version policy. |

**Mozilla.** Installed/latest `web-ext` is **10.7.0**, released 2026-09-21, source
`3c26c884e237282c072113483eda0eaddabb64f7`. Its
[release history](https://github.com/mozilla/web-ext/releases/tag/10.7.0) and
[submission implementation](https://github.com/mozilla/web-ext/blob/3c26c884e237282c072113483eda0eaddabb64f7/src/util/submit-addon.js)
were examined through authentication, upload, validation, create/PUT, source PATCH,
approval polling and download. The current command uses API v5; legacy v4 recipes
and removed `--use-submission-api` options are inapplicable. New Firefox schema
coverage and PATCH error reporting do not repair version-retry recovery.

The delivered adapter retains `JwtApiAuth`, `fileFromSync`, `doUploadSubmit` and
`doNewAddonOrVersionSubmit`. It replaces `nodeFetch`, JSON/error handling,
`waitRetry`, downloads and source PATCH response handling. The original polling
timer does not abort its request; the original PATCH path can echo service error
bodies. The replacements enforce fixed HTTPS destinations, credential isolation
across CDN redirects, response limits, abort signals and status-only errors.
No CRC-based upload-cache reuse is used.

AMO server code was inspected at
[`4b4e5bb354a846a548a0baade9f21504a2c5a92a`](https://github.com/mozilla/addons-server/tree/4b4e5bb354a846a548a0baade9f21504a2c5a92a),
including version uniqueness, owner downloads, source permissions, translated
custom licenses, review transitions and public serializers. This identifies the
reviewed upstream source, not the exact deployed server build. The
[v5 changelog](https://mozilla.github.io/addons-server/topics/api/overview.html#v5-api-changelog)
adds `site.submit_notification_warning` in August 2026; preflight now checks
maintenance state and surfaces that notice. Exact `versions/vVERSION/` lookup
enables recovery; only 404 admits creation. Versions cannot be reused after
deletion or across channels.

New versions receive a new `custom_license` object, avoiding inheritance of an
unrelated license or changes to a custom license shared with an older version.
The translated text is outer-trimmed to match
[DRF 3.18.1 validation](https://github.com/encode/django-rest-framework/blob/3.18.1/rest_framework/fields.py#L727).
Original internal formatting and both notices remain. Resume checks license and
source identity instead of patching old metadata. Source upload follows Mozilla's
[readable-source requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/).
The [multipart limitation](https://github.com/mozilla/addons-server/blob/4b4e5bb354a846a548a0baade9f21504a2c5a92a/docs/topics/api/addons.rst#L735)
and [inheritance implementation](https://github.com/mozilla/addons-server/blob/4b4e5bb354a846a548a0baade9f21504a2c5a92a/src/olympia/versions/models.py#L449)
were inspected. Inheritance consults the latest listed version with an empty
status-exclusion tuple; it is not an explicit request to reuse a inspected custom
license ID. The conditional mechanism is useful for a different ownership policy,
not categorically inferior. The selected policy favors independent, explicit
license ownership and one creation path over that conditional request saving.

Authenticated version detail includes `is_disabled`; the public serializer omits
it. The final anonymous check therefore uses public-access success, listed channel
and approved file status, together with the public add-on's disabling/status
fields. This distinction was checked against source and live read-only responses.

**GitHub.** Existing checkout **7.0.1** and upload-artifact **7.0.1** release pins
were rechecked; their prior [changelog/source audit](ci-source-audit.md) applies.
New download-artifact **8.0.1** is pinned to
`3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`. Its
[v8 release](https://github.com/actions/download-artifact/releases/tag/v8.0.0)
makes digest mismatch fatal and supports direct artifacts; 8.0.1 repairs
filename/content-type handling. Each handoff uses one exact artifact ID and an
explicit fatal digest policy. These handoffs contain multiple files, so ordinary
archived artifacts are appropriate; direct-XPI download mode is not used here.

GitHub CLI **2.101.0**, source `0cf1092493af067646fc5f3db9421c6a6ec9c938`, comes
from a small `release` shell in the same locked Nix input. Ordinary CI does not
install an unused GitHub CLI, and publication does not install browser/lint tools.
The reviewed
[create implementation](https://github.com/cli/cli/blob/v2.101.0/pkg/cmd/release/create/create.go)
automatically drafts ordinary asset releases, but deletes that draft on failure.
Explicit `--draft` preserves it. The tag lookup races published and draft queries;
therefore publication uploads/PATCH use REST release IDs, with the current
`2026-03-10` API version. Recovery lists history rather than interpreting a
published-by-tag 404 as proof that no draft exists.

The [2.97 security changes](https://github.com/cli/cli/releases/tag/v2.97.0) affect
attestation matching and token handling and are included in 2.101.0. The
[2.101 changelog](https://github.com/cli/cli/releases/tag/v2.101.0)'s Linux package-key
rotation does not affect the locked Nix package. `gh release verify-asset` checks
the local SHA-256 against GitHub's signed release attestation. Native
[immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
provide that attestation without a separate attestation action or OIDC grant.
The setting's [administrative read requirement](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
precludes a pre-publication setting query with the ordinary workflow token.

**New syntax and evaluator coverage.** GitHub's current
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)
supports `queue: max`, which prevents replacement of an already-pending release
until the 100-run bound. Stable/latest actionlint 1.7.12, and the inspected upstream
main parser, reject this key. Zizmor 1.30.1 accepts it but also accepts an invalid
queue value. This is an observed evaluator gap. A path/message-specific actionlint
exception is paired with a guard for this workflow's exact supported queue policy;
negative tests reject invalid values, cancellation and additional queue keys.
All other actionlint diagnostics remain active. Remove the bridge when upstream
supports the feature. The newer `$/` same-repository reference has equivalent
semantics here; `./` retains actionlint's actual reusable-workflow input checking,
with one documented zizmor exception rather than silently losing that check.

## Archive representation and costs

The conventional prototype used Info-ZIP member enumeration and one child process
per payload file. JSZip, already used internally by web-ext, is not sufficient
alone: it normalizes names and overwrites duplicate names in its object mapping.

Selected **yauzl 3.4.0**, source
[`f5798e15204ffbb9a428b00217e4659684a41b0f`](https://github.com/thejoshwolfe/yauzl/tree/f5798e15204ffbb9a428b00217e4659684a41b0f),
was already in the locked dependency graph; it is now an explicit dependency.
The [changelog](https://github.com/thejoshwolfe/yauzl/blob/f5798e15204ffbb9a428b00217e4659684a41b0f/README.md#change-history)
matters: 3.4 adds promises and async entry iteration; preceding fixes repair stream
interruption and malformed timestamp handling. Central-directory parsing,
local-header checks, lazy iteration, fd ownership, decompression, stream cleanup
and the small `pend` dependency were examined. The implementation reads one member
at a time, checks raw/local/decoded names, rejects duplicates, streams SHA-256 and
native CRC32, checks expanded sizes, and awaits descriptor closure in `finally`.
Firefox independently verifies Mozilla's cryptographic signature during permanent
installation. Signature-entry names alone are never treated as proof.

The selected path removes per-member child processes and whole expanded-member
buffers. Verification state is O(number of members), plus bounded stream buffers;
work is linear in archive metadata and decompressed payload bytes. Pending polling
reuses verified payload identity until AMO's hash/size changes, and checks source
again at final approval. Its data movement is proportional to changed archive
bytes plus metadata polls, rather than retransferring both archives every poll.
These are mechanism/cost bounds, not elapsed-time or RSS measurements. No benchmark
winner or simultaneous empirical dominance is claimed.

## Correctness and acceptance boundaries

Each run owns its local files. Tag/commit and artifact ID/digest bind job handoffs.
Only the signing step sees AMO credentials; only publication has repository write
permission. Failed writes are not automatically repeated. A new run reconciles
remote state before its next write. Source comparison precedes attachment;
asset comparison precedes publication; permanent-install verification precedes
handoff to the writer. Review and adversarial tests cover the relevant partial
states and service-response races.

The operator must coordinate external publishers and configure immutability.
Neither API supports an atomic cross-service release, conditional empty-source
attachment, or atomic tag validation plus publication. Signature/approval and
immutability observations have their documented scopes; no lock-free, wait-free,
globally linearizable or transactional release claim is made. The evidence file
distinguishes tests, read-only production observations, source-based reasoning,
and the outstanding first hosted publication.
