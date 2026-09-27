# Revised icon, personal build and listed submission

The owner supplied another `extension/icon.svg` and requested a new unlisted
build followed by a public submission, explicitly permitting replacement of a
pending review. The chosen versions are **1.1.11 unlisted** and **1.1.12 listed**.
Both keep add-on ID `stackma@extensions.local`, AMO ID `3078021`, Firefox 156
minimum, permissions, grouping behavior, default AMO updates and license terms.
The [evidence record](../evidence/release/icon-refresh.json) binds the source,
provider identities, verification results and cleanup snapshot.

The supplied SVG is used unchanged, SHA-256
`4b0b634ab7b77f2f7057478cee7457170ca9b29791dedee2eb42e68230358487`.
The existing Firefox renderer produces `listing/icon.png`. An icon-only AMO PATCH
was accepted; the CDN's processed 128px image has the expected marker `674f7513`
and identical decoded pixels. Other listing and version metadata were unchanged.

## Local checkout cleanup

The original checkout remained at 1.1.4 because earlier release work used isolated
worktrees. Of 45 dirty files, 21 matched current main and 23 matched earlier
merged revisions at the same path; only the latest SVG was unique. Those files
were not extra unmerged feature work.

With explicit owner approval, all 45 files were committed unchanged on the local
branch **`recovery/local-release-work-20260927`**, commit
`59e7c4ca88154bb7fe0935cf6ff9d8a9c7b7ac4c`. Each archived blob was verified before
switching back to `main` and fast-forwarding. No reset, clean, stash, force push,
or remote recovery branch was used. The complete pre-sync patch and untracked
archive also remain at `/tmp/tab-gantry-refresh-baseline.8uQL1o` in this workspace.

Inspect an old file without disturbing current work:

```sh
git show recovery/local-release-work-20260927:scripts/release/amo.js
git diff recovery/local-release-work-20260927 main -- scripts/release/amo.js
```

The recovery branch is an archive, not a release candidate. Do not merge its old
controller files over current main.

## Browser-test readiness repair

The icon PR exposed the previously observed native-ID fixture race: it selected
the initial popup tab's Marionette actor before navigation completed. Firefox
returned `Actor ... destroyed` after the native `afterUpdate` phase. The prior
1.1.10 run had reported `Document was unloaded` at the same boundary.

The test now reuses `createLoadedPopup`, already used by the naming test. It
registers exact-URL top-frame completion/error listeners before creating the tab,
handles completion before the creation response, and has a five-second deadline
and listener cleanup. Only then does it inspect the final popup document, checking
its URL and `readyState` before the unchanged product assertions. No product call
is retried and no assertion is relaxed.

The supplied Firefox source at `9e9b5f17f56187c1f5c8b9cdf79a01ff51a7b643`
explicitly returns from `ext-tabs.js` creation without waiting for load;
`WebNavigation.sys.mjs` emits completion after successful window load, and
Marionette's `evaluate.sys.mjs` rejects evaluation on document unload. Six existing
helper tests and three sequential Firefox 156 collision tests passed; repaired
hosted CI also passed. These checks establish the fixture's readiness mechanism
for this case, not freedom from every possible browser-test interruption.

## Release handoff

**Personal build delivered:** [signed 1.1.11 XPI](https://github.com/Quince-Pie/tab-gantry/releases/download/v1.1.11/tab-gantry-1.1.11.xpi).
Install it over the existing add-on through Firefox's Add-ons Manager → Install
Add-on From File. Mozilla version `6519793` was signed, permanently installed and
published as immutable GitHub release `397802436`, with all four asset digests,
native attestations and anonymous public downloads verified. Its signed SHA-256
is `bd0b5d665847222a8ff95f1a725d167b4d7ff6bc4595f7912a40bbd797c61617`.
The source is merge commit `87c55d7ef94bfcb08cccfe380e61d29a2a0f1c34` from
[PR #21](https://github.com/Quince-Pie/tab-gantry/pull/21), with a committed unlisted
exception against the reviewed icon base. Hosted PR and exact merged-main CI
passed before signing. Source, payload and complete WTFPL/CMU terms matched.

A real Firefox 156 manual upgrade from signed 1.1.8 retained the add-on ID,
installation date, native group IDs/title/color/collapse and a local-storage
sentinel. This uses the earlier acceptance harness with only its import path,
version/name constants and success message adapted; it does not claim default
AMO delivery of an unlisted build.

**Listed 1.1.12** is prepared from the same icon and product code through
[PR #22](https://github.com/Quince-Pie/tab-gantry/pull/22), source
`af369f2af48ea914d7e448345a4f1f55fc9a175a`. Its complete version-only tree and CI
passed. The [explicit submission run](https://github.com/Quince-Pie/tab-gantry/actions/runs/36348733406)
carries `supersede=1.1.10`, binding replacement to that exact pending version.
Mozilla accepted **version 6519819**, file **5063965**, named
`tab_gantry-1.1.12.zip`. Independent readback matched the tested package, exact
new SVG, source archive and inherited license `10390`. Pending 1.1.10 was disabled
as authorized; signed unlisted 1.1.11 remained public and unchanged.

The listed file is `unreviewed` and the listing is `nominated`. The publisher is
continuing its bounded approval wait; this record does not claim its terminal
conclusion, permanent signing or public availability. Source verification and
accepted submission are complete. Mozilla approval, listed signed publication
and actual default-AMO update delivery remain separate provider gates.

After submission, recovery uses the existing tag without another supersession:

```sh
gh workflow run release.yml --ref main --repo Quince-Pie/tab-gantry -f tag=v1.1.12
```

The scheduled resumer is the ordinary path after Mozilla approval. Once the
listed signed XPI is verified, exercise default-AMO delivery separately:

```sh
node scripts/release/update-test.js \
  --from-xpi=/path/to/tab-gantry-1.1.11.xpi \
  --from-version=1.1.11 --to-version=1.1.12 \
  --to-sha256=VERIFIED_SIGNED_1_1_12_SHA256 \
  --output=artifacts/update-1.1.11-to-1.1.12.json
```

No new release architecture is introduced. The existing qualification, credential
scopes, source/payload/license checks, immutable GitHub assets and recovery
mechanisms apply. Mozilla review time is external. Unlisted installation is
distinct from the default-AMO update acceptance that requires a higher approved
listed release.
