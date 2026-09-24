# Continuous integration contract and verification

The original CI verification record below is historical. The later
[release integration](releases.md) adds a reusable entry point, release-policy
tests and the narrowly scoped workflow-syntax bridge invoked with
`node scripts/ci/check-workflows.js`. Its tools and results are recorded separately
in [release qualification](release-qualification.md).

## Scope and budget

Add validation and maintenance for Stackma's existing Firefox 156 extension.
Preserve the extension, the approved names, browser support and the uncommitted
WTFPL changes. CI may produce unsigned build artifacts; it does not sign, publish
an AMO release, deploy, auto-approve or auto-merge changes. The repository is public
with default branch `main`, verified through GitHub's API on 2026-09-23.

Budget: 70 elapsed minutes from 2026-09-23 23:12 UTC to 2026-09-24 00:22 UTC,
including source/changelog review, delegated work, implementation and validation.
Original HEAD is `08dece9`; the pre-existing working-tree status and license
hashes are recorded in `artifacts/ci-baseline/`. No remote write is authorized by
this implementation task; hosted execution will require publishing the files.

Hard gates: propagate build/test/lint failures; run the specified Firefox major;
verify downloaded executables before execution; protect repository credentials
when running PR code; preserve diagnostics; and bound execution. Source and
package integrity, license inclusion, and repeatable XPI bytes remain required.
Supported CI environment is the GitHub-hosted Ubuntu 24.04 x86-64 image. This
runner choice does not narrow the extension's operating-system support claim.

Selection rule: satisfy those constraints first, then minimize redundant tool
installation, credential exposure, maintenance mechanisms, and unnecessary runner
work. Feedback latency, runner time, transferred bytes, dependency state and
review burden remain distinct; there is no invented workload mix or speed claim.
One job is appropriate for these short checks and sequential browser fixtures.
Benchmarks stay off shared hosted runners because those timings would not extend
the existing controlled performance evidence.

## Selected pipeline

Use the audited checkout v7.0.1 and upload-artifact v7.0.1 release commits, with
full SHA pins and readable version comments. Keep ordinary `pull_request`, push
to `main`, merge-queue validation, manual dispatch and weekly scheduled validation.
Use a read-only repository token, no persisted checkout credentials, bounded job
execution and cancellation of superseded runs for the same event/ref.
Nix commands use `--no-update-lock-file`, so a changed input reference cannot
silently resolve a different dependency in memory while leaving the lock untouched.

Install upstream Nix 2.35.2 from its checksum-pinned official bootstrap. That
bootstrap verifies the platform archive before extraction. The locked development
shell supplies Node 24, geckodriver, zip, formatter and workflow analyzers; installing
setup-node as well would duplicate the toolchain. Install the exact Firefox 156.0
acceptance-floor archive with a separately pinned SHA-512, rather than relying on
the runner image's Firefox 155 or following a rolling release.

The shell uses `mkShellNoCC`: the locked npm graph has no required native install
hooks and these commands need no C/C++ compiler. With the same selected tools,
`nix path-info --closure-size` reported 838,031,352 bytes for `mkShell` and
506,080,808 bytes for `mkShellNoCC` on x86-64. This is a Nix closure-size comparison,
not a download-size, latency or universal performance claim.

Run npm's clean lockfile install with dependency lifecycle scripts disabled;
this dependency graph contains no required install hooks. Check source types,
unit/alternative oracles, Mozilla extension lint, the editorial catalog and
licenses. Build twice and compare the actual XPI bytes. Run the real-browser
suites sequentially, including the native-ID collision fixture and installation
of the packaged XPI. Save fresh results under `artifacts/`, not over committed
historical evidence. Only a fully verified XPI is uploaded as a distributable;
failed runs can still upload diagnostic JSON/logs.

GNU/Linux installer checks have their own `npm run test:ci` target. The existing
platform-independent `npm test` does not gain a dependency on Bash or GNU tools.

Upload-artifact v7's `archive: false` preserves the XPI as the downloadable file,
instead of placing this ZIP-format package inside another ZIP. Diagnostics and
checksums are separate. A 14-day retention period is an operational default for
these small CI artifacts, not an experimentally optimal value.
The XPI filename includes the run attempt: v7 ignores `name` when `archive` is
false, and artifact names are immutable within a run. Unique attempt names let
a failed job be rerun after an earlier upload without deleting the earlier XPI.

## Maintenance

Native Dependabot handles weekly npm, GitHub Actions and Nix flake-lock update
PRs. Group minor/patch npm and action version changes; keep major changes separately
reviewable. Retain the current documented three-day version-update cooldown;
security updates bypass that delay. No auto-merge, PAT, updater action or custom
write-enabled workflow is needed. Review upstream changelogs and failed checks
before merging updates.

The exact Firefox baseline and upstream Nix bootstrap version/hash are intentional
manual pins in the installer scripts. Review the browser contract before changing
Firefox, and the upstream release notes/digest before changing Nix. Dependabot's
Nix entry updates the branch-tracking `flake.lock`, not these bootstrap pins.
SHA-pinned Actions receive version-update PRs, but GitHub currently does not offer
Dependabot vulnerability alerts for SHA references; those require semantic-version
references. Do not mistake automated version PRs for complete advisory coverage.

See [the source/changelog audit](ci-source-audit.md) for current identities,
mechanisms, credible alternatives and the reasons for the selected architecture.

## Validation record

The complete command sequence passed in a disposable Ubuntu 24.04.5 KVM guest
with four vCPUs and 4 GiB RAM. Its official cloud-image checksum was verified
before boot; native GTK/audio libraries were installed explicitly. No host
filesystems or credentials were mounted, host Nix was not changed, and the guest
and fixture server were stopped afterwards. This covers the actual upstream Nix
2.35.2 daemon bootstrap and downloaded Firefox 156.0, not only mocked installers.

Passed: actionlint 1.7.12, zizmor 1.30.1 offline/pedantic, ShellCheck 0.11.0,
Nix formatting/evaluation for both declared Linux architectures, a clean npm
install with lifecycle scripts disabled, strict JS type checking, 147 portable
tests plus nine installer tests, 74 grouping-alternative checks, 43 browser
integration cases, the native-ID fixture, and installed-XPI verification.
Two builds produced identical 24,528-byte XPIs, also matching the local build:
`dd9fac410b814dab597c03ecf39f9c5db35675c9f43cfd0a8630e250bc944ea1`.

Final review added explicit UTC scheduling, separated the Linux-only test target,
made lock mismatches fatal with `--no-update-lock-file`, preserved package-startup
process logs, and gave uploads unique attempt filenames. The affected checks were
rerun locally: final workflow/security/shell analysis, both test targets, normal
package installation, injected startup failure, a changed-input-reference lock
failure, and two upload attempts with unchanged bytes and valid checksums. The
Ubuntu guest ran the same test cases before that final command organization;
its source-archive digest is recorded separately from the final file hashes.

The negative lock test distinguishes a changed dependency reference from edited
content in a relative path input, which can legitimately follow the root source
without changing its lock entry. The former requires a lock update and is
rejected; `--no-write-lock-file` alone would resolve it in memory.

[Final validation](../evidence/ci/validation.json),
[Ubuntu integration](../evidence/ci/ubuntu-validation.json), and
[lock policy](../evidence/ci/lock-policy.json) preserve scope and identities.
The detailed guest logs remain in the local `artifacts/ci-ubuntu-vm.BzAVqtjG/`.

Configuration and command verification are complete for this scope; publication
and GitHub-hosted acceptance are pending. Checkout, artifact service uploads,
scheduler/merge-queue dispatch, and Dependabot's actual PR creation have not been
executed against GitHub. A cloud VM with explicit libraries is not the complete
hosted-runner image. No universal optimality or hosted latency claim is made.

After these files reach `main`, confirm the first CI run, select **Verify Firefox
156 extension** if adding a required status check, and confirm that dependency
graph/Dependabot security updates are enabled in repository settings. Security
updates and branch-protection settings are repository controls, not granted by
the read-only workflow. Required checks should include merge-group events when
using a merge queue. Manual dispatch and the weekly schedule require the workflow
on the default branch.
