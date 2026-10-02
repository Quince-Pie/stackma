# Release redesign: contract, qualification and evidence

The initial qualification below is followed by [hosted acceptance](release-acceptance.md)
and a separate [literal-optimality analysis](release-optimality.md), requested
after the local candidate was delivered.

Observation date: **2026-09-26**. Baseline: `997087de3e07b3ffb0b3968e1617b80997a42a6b`
**plus the supplied working tree**, not HEAD alone. The baseline included pending
review handling, a scheduler, a repository policy helper, tests, documentation
and `listing/icon.png`. Its 124 release tests passed before changes. A binary
patch/untracked snapshot was saved outside the repository;
the old operator guide is also preserved in [release history](release-history.md).
No reset, clean, stash, commit, push or remote mutation was performed in the
project. Disposable worktrees isolate browser/build experiments.

A finite **90-minute total budget**, starting **18:03:42 UTC**, covers research,
delegation, implementation, review, verification and delivery. The final record
reports actual elapsed time. Two bounded independent provider investigations
formed candidates before using earlier architecture recommendations. Subsequent
source audits tested those recommendations, including their claimed necessity.

## Contract and authority

| Requirement / classification | Evidence and consequence |
| --- | --- |
| Explicit owner decision: explicit version → PR → human merge → release | [Preparation record](release-preparation.md), also commit `6611e23` and `evidence/release/preparation.json`. Retain that authorization; no inferred semantic version or direct-main release bot. These repository records report earlier owner decisions; no original conversation transcript was supplied. A correction from the owner would supersede them. |
| Explicit owner decisions: no accidental pending supersession; pending-only success; automatic completion after approval; checkable settings | Supplied [owner request record](amo-review.md#contract-and-selection-rule) and `evidence/release/amo-review.json`. Retain the behavior, not the old polling/controller architecture. |
| Product/consumer constraints | Manifest, README and both licenses: desktop Firefox 156 minimum, MV3, `stackma@extensions.local`, existing permissions/behavior, absent custom update URL, WTFPL v2 original work and retained CMU terms. No product/version/dependency/license change in this task. |
| Distribution commitments | README/release history, existing AMO listing/submissions and immutable GitHub release: listed AMO plus signed XPI/source/audit/checksum GitHub assets. No unlisted channel, custom updater or new service. |
| Platform requirements | Mozilla signatures for permanent release-Firefox installation; stable identity and increasing compatible versions for updates; rebuildable source for generated `name-catalog.js`; source/archive and API bounds. Provider evidence below. |
| Integrity/recovery requirements | Exact tested payload/source, preserved observed conflicts, no automatic deletion/overwrite, approval rechecks, bounded operations, credential separation. Mocks check client behavior; they cannot prove remote publication. |
| Implementation choices, revisable here | Node/Nix, workflow topology, internal web-ext adapter, 15-minute/6-hour cadence, source-after-create, replay instead of durable pending draft storage, retry/scan limits. Prior claims of necessity or superiority were not promoted to owner authority. |
| Historical observations, not requirements | v1.1.1 version mismatch/empty immutable release; v1.1.2 license/manifest normalization; older disabled AMO versions; 1.1.4 pending. None authorizes rewriting remote history. |
| Consequential unknowns | Admin settings/secret scopes, hosted old-tag workflow-write permissions, source-on-create acceptance, review/automatic completion/immutable publication and consumer update delivery. They remain acceptance gates. |

Authorization in this task covers local changes, tests and read-only queries.
It does not cover deploying workflows, external PRs, submissions, settings/secrets
or repairing releases. Human merge in the **future deployed flow** authorizes
AMO submission, which may make the add-on available before GitHub publication.
GitHub environment approval cannot undo AMO availability.

## Scope and selection rule

Single extension; GitHub.com hosted Ubuntu 24.04 x86-64; Node 24 and locked source
build tools; the existing listed AMO add-on. Releases use canonical three-component
numeric versions, each at most 999999999. The nine-digit AMO rule is distinct from
Chrome's 65535 rule. Browser support and external effects are feasibility gates.

Objectives remain separate: operator actions, reliable completion/recovery,
maintenance surface, dependencies/service calls, controlled completion latency
and CI use. No release frequency, weights, latency SLA or equivalence margin was
supplied. Fixed-reference policy: preserve working guarantees and the established
cadence, address demonstrated failures, and remove unnecessary mutable state or
provider-private coupling when contract-matched mechanisms permit it. Do not
claim that more frequent polling or fewer lines automatically wins.

The user delegated cadence selection without supplying weights. Retaining the
baseline **15-minute wait / six-hour schedule** avoids inventing a preferred
latency-versus-runner-cost exchange. It is an established operating point, not a
proved optimal interval. A 30-minute schedule could reduce post-approval waiting
while increasing scheduled executions from 4 to 48 per day; no measured review
distribution establishes the preferred tradeoff. An external review duration is
not a controlled release latency. Schedules themselves are not delivery guarantees.

## Applicable frontier and decision

| Contender | Decisive mechanism, costs and disposition |
| --- | --- |
| Manual Developer Hub plus local verified GitHub completion (conventional control) | Supported provider interfaces and less custom submission code; requires artifact selection/recovery actions and does not satisfy automatic post-review completion alone. Not selected as the normal path; remains an explicit exceptional recovery channel. |
| Tag-only/local CLI/direct-main or inferred-version release | Initially considered independently; incompatible with the recorded owner version-PR/human-merge contract as sole initiation. A tag remains durable identity after verification. |
| Release Please / create-pull-request | Both can update the needed files. Their ordinary reconciliation rewrites existing refs/PRs. New-only guarded wrappers are feasible, but still require our tree/ref/PR ownership and interrupted-creation reconciliation. Retain the create-only REST preparation coordinator; no speed/dominance claim. Source trace below distinguishes action/library versions. |
| Full `web-ext sign` 10.7.0 | Maintained control rebuilds a ZIP, caches upload UUID after validation, blindly reuses it and PUTs a version, then attaches source and polls. It does not compare signed payload/source identities, recover already-created versions or bound all requests. A wrapper must replace most decisive lifecycle behavior. |
| web-ext private `submit-addon` client plus coordinator (supplied baseline) | Reused request/auth construction but inherited private interfaces and source-after-create. Direct v5 upload/version requests are small, published mechanisms needed for combined source creation. Replaced private inheritance; web-ext stays pinned for linting. |
| Frozen v4 signing API | Version-keyed signing is useful but lacks combined source/custom metadata. Bridging to v5 reintroduces the source-attachment failure interval and two API contracts. Not selected. |
| JSON custom license create, then source PATCH (baseline) | Independent custom license object per version, but an interruption lasting until human review can make source attachment impossible. That independence was a previous design preference, not an owner requirement. Replaced for new versions. |
| Multipart version creation with source and verified inherited license (selected) | Supported v5 mechanism makes source part of creation; one fewer mutation. Requires existing exact terms and coordinated writers; inherited objects are shared. Check the actual newest-created listed predecessor before upload and immediately before creation, and check resulting terms/source. Existing missing-source versions retain guarded PATCH recovery. |
| Durable pending GitHub draft/bundle | Can avoid rebuilding after review and retain unavailable old tool outputs; adds mutable staging assets, extra transfers/ownership/cleanup and an earlier write-credential boundary. Source replay demonstrated below works for the existing state and small deterministic package. Retain reconstruction from protected source; do not claim lifecycle CPU superiority. Revisit if rebuilding becomes costly or tools disappear. |
| Actions artifacts as sole durable state / runner waits until review | Artifact expiry and unbounded external review invalidate these as complete recovery mechanisms. Use ID/digest-bound artifacts within a run and reconstruct on later dispatch. |
| `gh release create TAG ASSETS` / release-it 21.1.0 | Both support draft-first creation. CLI's combined path deletes a release on upload/publish error, including ambiguous publish outcomes; upload retries lack digest reconciliation. release-it retries mutations and needs a separate AMO coordinator. Use explicit CLI draft creation plus ID-bound REST reconciliation, then CLI native attestation verification. |
| Pure point versus bulk AMO readiness reads | Point reads favor one pending tag and large public history; bulk favors many accumulated disabled/unpublished tags and few public versions. Adaptive planner resolves this specific challenger by comparing remaining request counts. No tag is omitted by the old newest-20 cutoff. |
| Pending/tag lookup alone versus durable source intent | Client timeout does not roll back AMO work; tag creation can also finish late. A preflight tag-order check cannot prove ordered admission. Commit one immutable `release-intents/vVERSION.json` with the version PR, before either API mutation. This uses existing reviewed Git state and adds no remote call. A mutable draft/journal can record more phases but adds transitions, writes and recovery; fixed waiting cannot prove completion. Select the source inventory with strict reconciliation of admitted intent. |

These are covering mechanism arguments and contract-derived experiments, not
claims that all possible framework adaptations are inferior. No relevant
replacement eliminates both provider reconciliation and source identity checks.
An independently hosted webhook/App or third-party publishing service adds a
service/credential/channel beyond what is justified here; AMO has no documented
developer approval webhook to replace the readiness check.

## Source identities and decisive findings

All observations below are dated **2026-09-26**. Published provider documentation
governs public interfaces; repository HEAD is not treated as production.

| Primary source | Inspected mechanism and applicable limit |
| --- | --- |
| [AMO production version](https://addons.mozilla.org/__version__), release `2026.09.17-1`, commit `c03d3c661bdbe22bb8f4a52fc46d63668bb31751` | Self-reported deployment identity. Compared decisive files to HEAD `b8e7d6002f9b8e01fd548fb7970d6837ee72bd7a`; relevant differences were not protocol changes. This is not an audit of production DB/configuration. |
| [Published v5 API](https://mozilla.github.io/addons-server/topics/api/addons.html), [authentication](https://mozilla.github.io/addons-server/topics/api/auth.html), [pagination](https://mozilla.github.io/addons-server/topics/api/overview.html#pagination) | Upload validation, source-on-create, inherited license, owner/private versus public versions, page size ≤50. v5 is explicitly unfrozen. Client owns this limited protocol surface. |
| Deployed [addons serializers](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/addons/serializers.py), [views](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/addons/views.py), [validators](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/addons/validators.py) | Version creation accepts multipart `upload`+`source`. Custom license requires translated JSON objects, so nested multipart/IDs are not a supported escape. `ReviewedSourceFileValidator` blocks source edits after human review absent pending rejection. Public version list defaults to approved listed files; list omits license text. |
| Deployed [versions model](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/versions/models.py), [add-on model](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/addons/models.py) | `from_upload → disable_old_files` disables earlier pending listed files. License predecessor is `find_latest_version(channel=listed, exclude=())`, including disabled/pending, with shared license ID. Nondeleted list orders by creation descending. No conditional predecessor/CAS. |
| Deployed [file serializer](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/files/serializers.py), [signing](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/lib/crypto/signing.py), [source download](https://github.com/mozilla/addons-server/blob/c03d3c661bdbe22bb8f4a52fc46d63668bb31751/src/olympia/versions/views.py) | Upload UUID is 32 hex digits. Signed hash/size change during signing; original unsigned hash is not exposed. JWT source downloads work for active owner versions, but disabled/deleted versions can deny source access. Temporary uploads expire after 15 days in `amo/cron.py`, not a retention SLA. |
| [Mozilla source policy](https://extensionworkshop.com/documentation/publish/source-code-submission/), [signing/distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) | Generated catalog requires matching rebuildable source; permanent Release Firefox installs need signing. No unlisted duplicate is required for mirroring the listed signed XPI on GitHub. |
| Supplied Firefox `9e9b5f17f56187c1f5c8b9cdf79a01ff51a7b643`, MDN content `8530cf97b809705c3524e733afcb69124b305b2e` | `XPIInstall.sys.mjs` signature ID/update URL selection; `AddonUpdateChecker.sys.mjs` newer compatible update selection; `browser/app/profile/firefox.js` AMO default update URL. MDN ID/strict-min/version documentation. These references support continuity reasoning, not actual hosted update delivery. |
| [web-ext 10.7.0](https://github.com/mozilla/web-ext/tree/3c26c884e237282c072113483eda0eaddabb64f7), installed lock 10.7.0 | Read installed `lib/cmd/sign.js`, `lib/util/submit-addon.js`, their auth/fetch/wait/cache/source paths and current upstream. Version-keyed reconciliation is absent; upload cache uses path/CRC-derived identity. |
| [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), [concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency), [environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) | Current bot-created PR checks can await approval; dispatch can chain with job token. `queue: max` retains 100 pending runs; environment policies check workflow ref, not checkout. Schedule delivery/inactivity and extra approval limits apply. actionlint 1.7.12 needs the existing narrow queue-policy bridge. |
| [Releases REST](https://docs.github.com/en/rest/releases/releases), [assets](https://docs.github.com/en/rest/releases/assets), [immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), API `2026-03-10` | Draft→assets→publish, asset state/size/digest, possible `starter` on failure, immutable assets/tag, native attestations. Existing tags make target_commitish unnecessary; omit it. Hosted old-workflow permission checks remain unverified and must not trigger automatic credential widening. |
| GitHub CLI 2.101.0, installed Nix and [source `0cf1092493af067646fc5f3db9421c6a6ec9c938`](https://github.com/cli/cli/tree/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/release) | `create/create.go` explicit draft branch versus delete-on-failure combined path; `shared/upload.go` retries; native verify-asset. Preserve complete inventory and target numeric release ID in our own writes. |
| [release-it 21.1.0 `ef1f03b…`](https://github.com/release-it/release-it/blob/ef1f03b3a09d3057c9e1af47879c4deba3f3fd40/lib/plugin/github/GitHub.js) | Followed create/upload/publish retry/parallel asset paths; these do not supply AMO state/byte reconciliation. |
| [Release Please 17.11.2 `05c6a4f…`](https://github.com/googleapis/release-please/tree/05c6a4f71022304d4edad24ea90c1c16324503d5/src), [action 5.0.0 `45996ed…`](https://github.com/googleapis/release-please-action/tree/45996ed1f6d02564a971a2fa1b5860e934307cf7), [create-pull-request 8.1.1 `5f6978f…`](https://github.com/peter-evans/create-pull-request/tree/5f6978faf089d4d20b00c7766989d076bb2fc7f1/src) | Fresh primary bytes matched archived snippets. Traced RP manifest/extra-files/empty-changelog gates through GitHub code-suggester `updateRef(force)`. CPR resets/force-with-lease or API force-update and PR rewrites. Action 5.0.0 actually locks RP **17.6.0**, not latest library 17.11.2; the old comparison conflated them. |

No earlier reference-source directory existed. Added reference checkouts stayed outside
the project, as did the source notes; material findings are captured here.

## Mechanism mapping and invariants

- **Intent/source:** PR marker selects release intent, not authentication. Same
  repository, human merged event, main ancestry and version increase establish
  automatic authority. Manual recovery needs an existing tag or an explicitly
  identified merged release PR, whose same checks authorize missing-tag recovery
  with current code. Current REST [removed `merge_commit_sha`](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes#version-2026-03-10),
  so recovery reads PR metadata and its unique [merged issue event](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#merged)
  with `pull-requests: read`; it never substitutes the PR head. Two anonymous
  GETs resolved actual PR #3 to integrated commit `997087de…`. Normal webhook
  handling retains the field described in the [current webhook schema](https://github.com/octokit/webhooks/blob/7dd7fa56498a827a08b71919fae89428f5e8e283/payload-schemas/api.github.com/common/pull-request.schema.json).
  Hosted squash/rebase/queue recovery was not exercised. Versions/ID/minimum
  agree; staging excludes untracked payload and tracked `.env` before archiving.
- **Recovery identity:** protected commit/tag + deterministic source tools + AMO
  exact version/content are durable. Current staging is run inside the frozen
  source checkout; it does not put the controller into that archive. The new
  controller works even if an old staging script throws. Source reconstruction
  after deleting all within-run inputs is tested.
- **Submission:** verify local digests, listing and exact version first. Only
  authenticated version absence permits creation. Pending and predecessor-term
  checks run before upload and after validation. Version POST includes source;
  read back source/license/payload. Never retry a mutating request in that run.
  A lost upload can orphan data; a lost create is reconciled by version on rerun.
- **Ambiguous previous operations:** preparation adds a canonical intent record
  in the same expected Git tree as the version update. Main's admitted records
  cannot be modified/deleted/moved; full first-parent history and file types/bytes
  are checked. The source version must be its newest recorded intent. Staging
  binds the frozen source's other intents as `priorReleases`. Before new upload
  or creation, each must have an owner-visible AMO result or terminal publication.
  This works even if its tag POST has not yet become visible. An older source
  retry does not depend on future intents absent from its snapshot. Legacy
  source has no new field and may resume existing AMO versions only.
- **Permanent pre-submission failure:** an immutable intent must not permanently
  prevent a corrected version after a known build/upload rejection. A separate
  reviewed `release-retirements.json` records the exact tag, reason, evidence and
  operator assertion that no request remains in flight. Current resolution/signing
  refuse that target; higher submissions may skip only that retired prior intent.
  The normal AMO pending guard is unchanged. This is deliberately human recovery,
  not inference of cancellation from 404/timeout. Unknown outcomes cannot safely
  be retired, and old controller runs must not be restarted after retirement.
- **Signing transition:** hash/size changes trigger another download and payload
  check. Version ID cannot change during reconciliation. Return pending only
  after correct payload/source/license; approval additionally requires public
  listing and file. Current workflow proceeds only for `approved-and-signed`,
  never missing/unknown output. Missing source on a legacy version is attached
  only after payload/license and fresh empty-source checks.
- **Publication:** recheck tag/public AMO before draft work and immediately before
  publish; all assets must match the inventory, with no extras/duplicates/partial
  uploads. Writes use the validated release ID. Lost publish reply leaves a
  published release to verify; no automatic delete, clobber or tag replacement.
- **Completion visibility:** owned published tags are not automatically assumed
  verified. The planner examines retained failed bot attempts and actual current
  job-attempt steps. Only success of `Reconcile, publish and verify the immutable
  release` clears that gate. A skipped publisher in a green run cannot clear it;
  a diagnostics-upload failure after that step does not invalidate it. Later
  human recovery is checked in a bounded history window. Existing two-attempt
  allowance covers recovery before an actionable failure report.
- **Trust/lifetime:** product builds/tests run read-only; the privileged signer
  executes current reviewed code. Credentials are step-scoped, JWT stays on AMO
  origin, CDN redirects receive no JWT, API redirects are rejected. Native Node
  HMAC/fetch/FormData replace private web-ext request code. Protocol/JWT tests and
  actual GET-only authentication/payload/source checks cover the adaptation.

No global linearizability/lock-free claim applies. Queues serialize workflow
writers only. AMO inheritance is not a conditional write; no client can make
preflight+POST atomic against an outside administrator. The operated contract
requires coordinated writers. Deployed list ordering is implementation evidence,
not a published sorting guarantee; timestamp ties in historical creation could
be ambiguous because AMO exposes file-created time, not version-created time.
The inspected actual predecessor/history is unambiguous, and post-create terms
are verified. Provider changes, concurrent administrators or differing tied
predecessor licenses invalidate that assumption and require investigation.
Source-on-create is one provider request, not proof of transactional filesystem
storage/signing. All uncertain outcomes still reconcile through reads.

For the intent barrier, induction depends on protected source history, increasing
admitted versions, complete source inventory, globally serialized controllers and
an inventoried migration with no old controllers/other writers in flight. If A's
tag or AMO POST is ambiguous, later source B already contains A's committed intent,
so B cannot submit while A's AMO outcome is invisible. Retrying A uses A's snapshot,
without B's later intent; same-version uniqueness safely settles an in-flight
create. Normal/squash/rebase/merge-queue cases and source snapshot isolation are
tested. Missing provider visibility conservatively blocks progression. This is
not a guarantee against arbitrary inconsistent provider histories or an
administrator forging/removing state. Review explicitly rejected the tempting
tag-only monotonic guard because its own create-ref request could finish late.
Retirement adds the explicit premise that the operator has established the
absence of in-flight writes and has revoked old attempts. Its checked JSON records
that decision; a boolean or reviewer agreement alone cannot establish the external
fact. The supplied policy is empty. Tests check exact retirement scope and refusal
of retired targets before provider calls; no retirement was applied remotely.

## Costs, bounds and comparison coverage

The actual 1.1.4 package is **24,528 bytes** and committed source **606,043 bytes**.
Read-only replay needed **five GETs** and matched both byte identities; unsigned
installation also passed. This demonstrates migration at actual scale, not a
representative release frequency or an elapsed-time superiority result.

New version creation uses two mutations (upload, version-with-source), versus
three in the source-PATCH baseline. It adds predecessor detail checks and retains
pending history checks; existing owner results also settle committed prior intent.
Unobservable prior intent may need a terminal GitHub history lookup. Its small
record travels in the existing Git tree request, without another mutation. The
data still must be transferred and hashed. Source
replay spends CI again after delayed approval; it saves a separate persistent
pending-bundle protocol. No external review wait is counted as a performance win.

For readiness, let N be candidate versions and P the number of public-list API
pages (including one empty page). With fixed valid history, N=1 needs one detail
read; otherwise the adaptive scan takes at most P approval reads and at most
N+1 reads, excluding the common listing eligibility GET. After each page, it
compares remaining point-read count with remaining page count; ties choose points.
Tests independently model provider data and assert the ready set and exact calls:

| Scenario | Total AMO GETs |
| --- | ---: |
| 5,001 public versions, one candidate | 2 |
| 120 unpublished tags, two public versions | 2 |
| 200 public versions, two candidates beyond first page | 4 (pure points: 3; one information-read cost) |
| 200 public versions, one candidate on first page and one late | 3 |
| 51 public versions, three candidates favoring pages | 3 |

This is a structural service-call bound and deterministic protocol measurement.
It does not prove optimal bytes, CPU, latency or whole-system dominance. API
decisions can change between reads; publication revalidates them. Filtering and
paginating bot-only dispatch history fixes the previous 100-run truncated-count
assumption; counts cannot survive provider deletion/retention.

When owned publications exist, monitoring adds a bot-history read per page; healthy
first successful attempts need no jobs query. Failed attempts/reruns and relevant
later recovery use at most 50 job-history reads, each requiring a complete result
of at most 100 jobs. Only unresolved verification triggers a second bounded
all-actor history search. API [job-attempt records](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)
were checked against the published `2026-03-10` contract. Monitoring covers retained
evidence; deletion/expiry cannot establish lifetime verification. No new mutable
completion marker, credential or competing verifier is introduced.

Resource limits fail visibly: 100 pending workflow queue entries; jobs limited
to 10/20/10/35/20 minutes for resolve/verify/tag/sign/publish; 15-minute scheduler;
100 readiness reads, fewer than 1,000 retained bot-dispatch search results;
1,000 intent records and AMO owner versions; 10,000 GitHub releases; 16 nested tag
objects; merged-PR recovery requires a complete history below 1,000 issue events.
Intent history commands have 30-second / 4 MiB output bounds. HTTP
requests, subprocesses and ZIP reads have finite deadlines; JSON is bounded
where provider pagination/signing uses it; AMO downloads ≤200 MB. Reaching a
bound is an explicit recovery condition, never evidence that unseen work is absent.

## Verification and acceptance status

The [evidence JSON](../evidence/release/redesign.json) identifies delivered file
hashes, commands, environment, actual results and remaining gates. Existing and
new tests cover authorization, merge shapes, conflicting/changed refs, upload and
create ambiguity, pending/supersession, inherited license drift, source conflicts,
signing transitions, malformed/oversized responses, credential destinations,
partial/ambiguous GitHub publication, old Latest, artifact expiry, current-controller
recovery, pagination bounds and dispatch ambiguity. Independent review found
and fixed the 32-hex upload UUID assumption and malformed-JSON body leakage.
The read-only PR recovery probe also rejected the initial obsolete REST-field
assumption; the revised merge-event adapter was exercised against actual PR #3.

Local source/type/lint/unit/installer/release/workflow checks and Firefox product,
metadata, naming, native-ID, version-boundary and package checks passed. An unsigned
permanent installation was rejected as `ERROR_SIGNEDSTATE_REQUIRED`. These facts
do not establish a successful approved Tab Gantry signed installation or hosted run.

**Contract/local verification:** implemented and verified within the recorded
scope; remote setup and hosted acceptance remain open. **Design qualification:**
supported for the actual product, owner contract, deployed mechanisms and stated
operating assumptions; current strong alternatives were examined. **Full release
acceptance:** unmet until the operator guide's hosted checklist passes, including
old-tag permissions and installed-user update delivery. Retain this as a candidate,
not a completed production release system. **Literal universal optimality:**
neither established nor claimed.
