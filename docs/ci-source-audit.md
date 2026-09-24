# CI source audit and design selection

Source review date: **2026-09-23**. The selection is for a read-only,
GitHub-hosted Ubuntu 24.04 job that checks Stackma against Firefox **156.0**,
validates its existing Nix development environment, and produces a verified
unsigned XPI. See [CI operation and verification](ci.md) for the workflow contract,
commands, and actual execution coverage.

The priorities are preserving that browser baseline, executing reviewed inputs,
propagating failures, and keeping maintenance understandable. No timing comparison
or claim of fastest CI was made. Adding another setup action or a newer language
runtime is useful only if it improves those properties.

## Selected actions: versions, mechanisms, and changelog consequences

Release identities were checked against the official repositories' latest-release
API responses and Git tag refs, rather than inferred from examples using a major
tag.

| Action | Selected release | Full commit |
| --- | --- | --- |
| `actions/checkout` | v7.0.1, released 2026-07-20 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/upload-artifact` | v7.0.1, released 2026-04-10 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

Both release API responses reported `immutable: false`. Full commit pins bind
the reviewed executable, while same-line release comments make updates reviewable.
Both actions use Node 24 internally, requiring Actions Runner 2.327.1 or newer;
this runtime is separate from the Node version used to test Stackma.

**Checkout.** The [pinned changelog](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/CHANGELOG.md)
was read together with its metadata, input parser, unsafe-PR guard,
[fetch/checkout lifecycle](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/src/git-source-provider.ts),
and credential cleanup. V7 rejects recognized attempts to check out fork PR code
in privileged `pull_request_target` or `workflow_run` contexts. V7.0.1 fixes the
default-checkout handling, Unicode-whitespace ref classification, and Git config
value escaping. These protections supplement the workflow's ordinary
`pull_request` trigger; they do not make privileged execution of untrusted code
safe. No unsafe-checkout opt-in is used.

`persist-credentials: false` removes authentication during checkout's `finally`
path, before repository commands execute. The v6 improvement that moved
persistent credentials into `RUNNER_TEMP` therefore need not be relied upon.
A shallow checkout of the event's default ref is sufficient: validation requires
the proposed tree, not full history, tags, LFS, or submodules.

**Artifact upload.** [V7's release](https://github.com/actions/upload-artifact/releases/tag/v7.0.0)
introduces direct single-file uploads through `archive: false`. The XPI is already
a ZIP, so this preserves the downloadable XPI without a second archive. The
[pinned upload path](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/src/upload/upload-artifact.ts)
rejects multiple matches in this mode, and the filename becomes the artifact name.
Missing packages use `if-no-files-found: error`; the upstream default only warns.
Checksums and reports can use a separate archived artifact.

The [v7.0.1 release](https://github.com/actions/upload-artifact/releases/tag/v7.0.1)
updates its HTTP runtime dependency. The pinned lockfile identifies
`@actions/artifact` 6.2.0 and `@typespec/ts-http-runtime` 0.3.5. Inspection of the
bundled upload code confirmed use of `ACTIONS_RUNTIME_TOKEN` and
`ACTIONS_RESULTS_URL`; normal workflow artifact upload does not require
repository `actions: write`. Artifact URLs require GitHub authentication and
expire with their artifacts. Uploading an artifact does not sign or publish the
extension as a release.

## Toolchain and bootstrap alternatives

The accepted Nix input remains pinned by [flake.lock](../flake.lock) to nixpkgs
`8825bebf6324e0579d012936eff73379af284b6d`, with its recorded NAR hash. Using it
for Node 24, geckodriver, ZIP tooling, and the workflow analyzers makes CI use the
same declared development environment. This is a consistency argument, not an
unmeasured installation-speed claim.

The upstream Nix 2.35.2 bootstrap is fetched from
`https://releases.nixos.org/nix/nix-2.35.2/install` and checked before execution:

```text
bootstrap SHA-256:
9adda97297d9e8ab360df95c729eabff4f4f93d6db091953c3a68f29e3fb130c

embedded x86_64-linux archive SHA-256:
0c3960a9792331a22081c3c7a5d8465db9b17c50b3acdf18587fa4c6f2cb1158
```

The complete bootstrap verifies the archive before extracting and invoking it.
The [archive install dispatcher](https://github.com/NixOS/nix/blob/2.35.2/scripts/install-nix-from-tarball.sh),
multi-user configuration path, and
[Linux systemd setup](https://github.com/NixOS/nix/blob/2.35.2/scripts/install-systemd-multi-user.sh)
were inspected. The supported upstream installer owns creation of build users,
the store, and daemon services inside the disposable runner. The workflow supplies
flake configuration and environment setup without persisting a GitHub token in
Nix configuration. Bootstrap version/hash changes require review together.

Firefox installation is independently pinned to the contract's 156.0 archive and
its checksum. A browser-channel resolver is unnecessary for this fixed baseline;
a moving stable browser would change what the tests establish.

| Contender and inspected identity | Applicable advantage | Selection consequence |
| --- | --- | --- |
| `actions/setup-node` v7.0.0, `820762786026740c76f36085b0efc47a31fe5020` | Maintained Node download/cache handling and npm-cache support | Omitted because Nix already supplies the declared Node toolchain. A second resolver would add another version and cache policy to maintain. |
| `cachix/install-nix-action` v31.11.1, `13d8dd58da0234aa297dedd986986ccb8e7f3e24` | Maintained upstream Nix installation and environment setup | Viable control, but its complete shell path injects the job token into nix.conf and enables KVM/trusted-user changes by default. It downloads its bootstrap without a separate pinned script digest. Direct verified upstream installation avoids these unnecessary behaviors for the selected fresh Linux runner. |
| `DeterminateSystems/nix-installer-action` v23, `3138316df39ed29be04236d7ffc686fa525866aa` | Installer lifecycle support and optional telemetry/build summaries | Rejected for this contract: its current README explicitly calls upstream Nix installation unsupported and potentially removable. The default installs Determinate Nix; changing that input does not restore upstream support. |
| `NixOS/nix-installer-action` v1.0.0, `d8c2fe395ce92e3181683832e41e692ffd659031` | Upstream-owned action around the newer installer, including container daemon startup | Its complete composite path defaults to downloading the latest experimental installer without a digest check. A separately verified local installer is possible, but adds another installer implementation without a required capability for this systemd VM. |
| `zizmorcore/zizmor-action` v0.6.4, `cc914d7f3750a2d13d75c7f184a1060aa0e9d482` | Digest-pinned Docker image, read-only workspace mount, annotations/SARIF integration | A valid alternative. Direct zizmor 1.30.1 from locked nixpkgs supplies the same analyzer without a second image, wrapper, or optional CodeQL upload action. |

Relevant primary records are the
[setup-node release and source](https://github.com/actions/setup-node/releases/tag/v7.0.0),
[Cachix changelog](https://github.com/cachix/install-nix-action/releases/tag/v31),
[Determinate support statement](https://github.com/DeterminateSystems/nix-installer-action/blob/3138316df39ed29be04236d7ffc686fa525866aa/README.md#installing-upstream-nix),
[NixOS action source](https://github.com/NixOS/nix-installer-action/blob/d8c2fe395ce92e3181683832e41e692ffd659031/action.yml),
and [zizmor wrapper](https://github.com/zizmorcore/zizmor-action/blob/cc914d7f3750a2d13d75c7f184a1060aa0e9d482/action.sh).

Changelog details mattered to this comparison. Cachix v31.11.1 moves to Nix
2.35.2 to fix a build-aborting coroutine assertion; earlier releases include
environment setup repairs, security fixes, and a reverted Nix update.
Determinate v23 records dependency/runtime updates, upstream support clarification,
and telemetry changes. Setup-node v7 adds cache-key outputs, changes internal
modules to ESM, and removes a dummy authentication-token fallback. Its release
notes mention `@actions/cache` 5.1.0, but its pinned lockfile actually contains
6.1.0: source inspection determined the shipped dependency, not that notes entry.
Zizmor-action v0.6.4 selects analyzer 1.30.1 through a checked-in image digest.

## Maintenance and remaining boundaries

Native Dependabot covers the selected action references, npm dependencies, and
the branch-tracking Nix flake lock. GitHub announced
[Nix version-update support](https://github.blog/changelog/2026-04-07-dependabot-version-updates-now-support-the-nix-ecosystem/)
for public repositories; Stackma's public repository and branch-tracking input
match that scope. No claim is made here about unsupported Nix input forms.
GitHub subsequently introduced a
[default three-day package cooldown](https://github.blog/changelog/2026-07-14-dependabot-version-updates-introduce-default-package-cooldown/).
That delay is an upstream maintenance policy, not evidence that a dependency is
safe after three days. Version PRs still require review and CI; no automatic
approval, merge, or release job is needed.

The Actions updater and version-comment mechanism were inspected in
[dependabot-core `f8de02f945831e30fede81667ea72c16dc81f765`](https://github.com/dependabot/dependabot-core/blob/f8de02f945831e30fede81667ea72c16dc81f765/github_actions/lib/dependabot/github_actions/update_checker.rb).
Pins matching actual release tags can advance to new release SHAs, preserving
full pins and matching same-line version comments. Untagged pins can follow a
containing branch, which is another reason to use verified release commits.
GitHub's [security documentation](https://docs.github.com/en/actions/reference/security/secure-use)
explicitly distinguishes version updates from vulnerability alerts: Actions
alerts do **not** cover SHA-pinned actions. Release review and regular update PRs
therefore remain necessary; this configuration does not claim complete advisory
coverage.

The official [gh-actions-lock](https://github.com/github/gh-actions-lock) is a
credible successor mechanism: it adds repository-identity/ref-reachability checks
and transitive dependency locking. Its latest reviewed release, v0.1.6, is
explicitly a Technical Preview with changeable format and behavior. Adoption is
deferred pending stable support, rather than described as equivalent to SHA pins.
The selected actions are bundled JavaScript actions without additional composite
`uses` dependencies.

This record establishes source-based selection for the declared workflow. It is
not proof that every possible workflow is inferior, a complete audit of all
transitive executable code, or evidence that GitHub has executed the workflow.
Hosted event permissions, uploads, and Dependabot execution must be observed on
GitHub; local analyzer/test success cannot substitute for that observation.

## Workflow analyzers reviewed

The [actionlint 1.7.12 release notes](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)
add IANA timezone validation for `on.schedule`, refresh webhook activity types and
popular-action metadata, and support newer runner labels. The workflow explicitly
uses `Etc/UTC`; that schedule is checked with the release that understands the
field. Other new platform features are not enabled without a task need.

[Zizmor 1.30.1](https://github.com/zizmorcore/zizmor/releases/tag/v1.30.1) corrects
GitHub-URL handling and classification of unsafe self-repository auto-fixes. CI
uses its offline pedantic analysis with normal error propagation; it does not
apply automatic fixes or grant a token for online analysis. ShellCheck 0.11.0
checks the repository's installer scripts, and actionlint also checks inline
workflow shell. All three are provided by the locked Nix environment.
