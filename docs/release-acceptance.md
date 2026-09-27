# Hosted acceptance and remaining provider gates

**Current handoff, 2026-09-27:** the owner renamed the extension to **Tab Gantry**.
Unlisted [1.1.8 is signed and published](https://github.com/Quince-Pie/stackma/releases/tag/v1.1.8),
and a real manual upgrade from 1.1.6 preserved native groups and local storage. Listed
1.1.9 was submitted with explicit authorization to replace pending 1.1.7; Mozilla
disabled the older pending file on creation. The title is now **Tab Gantry -
Automatic Tab Groups**. See the [current rename record](tab-gantry-rename.md).
Listed approval/publication and actual default-AMO update delivery remain open.
The dated rollout observations below are historical, not instructions to resume
superseded 1.1.7 or owner-disabled 1.1.4.

**Later owner-authorized change:** the owner disabled listed 1.1.4, merged the
1.1.5 version PR, then requested unlisted 1.1.6. That release is now signed,
verified and [published](https://github.com/Quince-Pie/stackma/releases/tag/v1.1.6);
see its [acceptance record](unlisted-1.1.6.md). The historical 1.1.4 → 1.1.5 plan
below is superseded. A future default-AMO update test can start from signed
1.1.6 and target a compatible approved **listed** version higher than 1.1.6.
Unlisted signing does not establish listed-channel publication or automatic
update delivery.

The owner subsequently requested listed **1.1.7**. Its [submission record](listed-1.1.7.md)
documents the successful hosted merge trigger, exact source/license verification
and remaining Mozilla-review/update-delivery gates.

This is the continuation of the local [design qualification](release-design.md).
On 2026-09-26 the owner authorized completing repository setup and live release
acceptance, and supplied administrator API access through the ignored local
environment file. Credentials are not part of this record or any source archive.
The combined investigation/implementation/rollout budget is 180 minutes; the
initial implementation used approximately 85 minutes.

## Established on GitHub

- [Implementation PR #4](https://github.com/Quince-Pie/stackma/pull/4) was reviewed
  at head `742e313385bd8ea1d4a579511bdb94840cf56ddb` and merged as
  `e020a3f1fc092f07c0d4314ee3cb1193b7a5e7f6` after
  [hosted CI passed](https://github.com/Quince-Pie/stackma/actions/runs/36269477579).
  CI exercised the real hosted tools, Firefox tests, reproducible packages and
  artifact uploads. The earlier [implementation-only run](https://github.com/Quince-Pie/stackma/actions/runs/36269187663)
  also passed.
- Active rulesets now prevent moving/deleting `v*` tags and force-pushing/deleting
  main. The signing and publication environments allow only the `main` branch.
  Immutable releases and Actions PR creation were already enabled and were
  confirmed with administrator access.
- The required AMO issuer/secret pair is configured in `release-signing`.
  The hosted signer successfully authenticated with that environment's pair.
  The four historical repository-scoped aliases were then removed; a final
  metadata read confirms that only the environment pair remains.
- [Release preparation](https://github.com/Quince-Pie/stackma/actions/runs/36270471675)
  succeeded and created [version PR #5](https://github.com/Quince-Pie/stackma/pull/5).
  Its four files contain only the intended version fields and new immutable
  `v1.1.5` intent. The bot-triggered CI required approval; the owner-authorized
  approval was performed, and [that CI passed](https://github.com/Quince-Pie/stackma/actions/runs/36270530428).
  The PR is deliberately unmerged while 1.1.4 awaits Mozilla review.

The [live 1.1.4 controller run](https://github.com/Quince-Pie/stackma/actions/runs/36270030489)
exercises current-controller recovery of the historical source. It resolves and
tests commit `997087de3e07b3ffb0b3968e1617b80997a42a6b`, reconciles its protected
tag, and checks the existing AMO version instead of creating a replacement.
It completed successfully with `awaiting-review`; permanent installation and
GitHub publication were correctly skipped. The independently dispatched
[resume workflow](https://github.com/Quince-Pie/stackma/actions/runs/36270820273)
also passed and correctly found no approved version ready to publish. This
exercises the scheduled workflow's controller, not GitHub's delivery of a future
cron event.
The [machine-readable record](../evidence/release/hosted.json) records the observed
run outcome and distinguishes pending review from completed publication.

## What cannot be inferred from those results

Mozilla still controls approval/signing of its nominated listing. A pending run
is not publication success. Do not merge 1.1.5 to try to accelerate that decision:
AMO would disable an older pending version. No supersession is authorized by the
ordinary acceptance path. No existing release or source archive is overwritten.
The authenticated observation at **2026-09-26 21:01 UTC** still shows version
1.1.4 (`6511539`) as `unreviewed`, with source attached. The old empty immutable
GitHub release `v1.1.1` is preserved. No new AMO upload/version or GitHub release
was created during this rollout.

After 1.1.4 is approved, verify that automatic resumption installs the signed
package and completes all four immutable GitHub assets and native attestations.
Then review/merge version PR #5. Its actual version creation must confirm the new
combined source-upload protocol, inherited terms, approval, signed installation
and repeated GitHub completion. These are distinct gates; one successful CI run
does not establish them all.

The automatic resumer is enabled on its six-hour schedule. After approval it
reuses all release checks. A maintainer can run it sooner with
`gh workflow run resume-release.yml --ref main --repo Quince-Pie/stackma`.
GitHub can delay/drop scheduled runs or disable schedules after inactivity;
see the [recovery procedures](releases.md). This record does not promise a
completion deadline while either provider is unavailable.

## Actual installed-user update test

The new harness deliberately uses Firefox's normal AMO updater, rather than
installing a supplied newer XPI directly. It needs an older signed XPI and a
compatible approved newer listed version with its verified signed archive's
SHA-256. The older installation can come from unlisted self-distribution; its
unchanged ID and default update service still select compatible listed updates.
Verify the old package against its release attestation first:

```sh
gh release verify-asset v1.1.4 /path/to/stackma-1.1.4.xpi --repo Quince-Pie/stackma
node scripts/release/update-test.js \
  --from-xpi=/path/to/stackma-1.1.4.xpi \
  --from-version=1.1.4 \
  --to-version=1.1.5 \
  --to-sha256=VERIFIED_SIGNED_XPI_SHA256 \
  --output=artifacts/release-update-acceptance.json
```

The profile is disposable. The harness restores Firefox's **shipped** update
endpoints because Marionette otherwise substitutes dummy URLs, enables networking
for this test, and keeps signature enforcement enabled. It does not use an
alternate update manifest. Browser services may make normal network requests;
this is not a host-restricted network sandbox.

The actual returned update is downloaded, paused, independently hashed against
the expected signed package, then installed. The test checks permanent active
signature/ID/version continuity, native group metadata and extension storage.
Its update phase is bounded at 120 seconds, with bounded browser lifetime and
cleanup. Use exclusively owned scratch report/log paths; observed hardlink or
symlink aliases are rejected before they can overwrite the input package.

The callback unit tests validate the harness, not Mozilla delivery. A real browser
negative control confirmed the shipped AMO endpoint restoration and rejection of
an unsigned permanent baseline. No positive update result is claimed until the
actual approved packages pass. The test exercises an explicit user-requested
update; normal periodic-update cadence is a separate scope.

## Literal universal optimality

The stronger follow-up demand is analyzed in [release optimality](release-optimality.md).
In the documented online observation model, a universal winner cannot simultaneously
dominate every feasible design on total API requests and controlled completion
delay for every permitted approval history. The proof covers arbitrary contenders,
includes the complete protocol cost, and identifies its invalidating assumptions.
An unrestricted all-programs/all-physical-cost claim remains unestablished. Neither
that theorem nor hosted acceptance certifies the delivered design as universally
optimal.
