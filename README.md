# Tab Gantry

Formerly Stackma. The Firefox add-on ID and existing update path are unchanged.
The repository and AMO URL use `tab-gantry`; see the
[URL and icon migration](docs/url-and-icon-rename.md).

Automatic related-tab stacks for **Firefox desktop 156** and **Chrome 148 or
later** using native tab groups. Open a link in a new tab: it joins the opener's
group, or starts a group with the opener. Descendants stay together, including
bursts of new tabs. New Tab Gantry groups receive a generated word-pair name.
Firefox supplies the group menus, colors and collapse controls; manual names
remain yours.

- Pinned endpoints and relationships across windows are left alone, as requested.
- Unrelated new tabs are left alone. There are no domain, title or active-tab guesses.
- If Firefox reports no source, the tab stays unchanged. This includes some
  inactive-tab duplicates; link opens are covered by the browser's creation signals.
- No content scripts, network requests, analytics, runtime dependencies or saved
  browsing history. `webNavigation` supplies the source of new link targets,
  including links without a DOM opener. URLs in those events are not used.
- Grouping a split-view tab also groups its companion, as Firefox requires.
- Automatic work happens once per observed creation. Later manual changes stay
  yours. Firefox itself may also inherit a group during tab creation.
- In Chrome, a tab counts as related only when a page opened it: Chrome reports
  the active tab as the opener of Ctrl+T and New Tab button tabs too, so those
  stay alone. See [Chrome support](docs/chrome.md).

## Install

For local use, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
Add-on**, and select `extension/manifest.json`. It starts immediately. Allow it in
private windows in Firefox's add-on settings if wanted. Temporary installation
lasts until Firefox restarts.

`npm run build` produces `dist/tab-gantry-VERSION.xpi` for the version in
`extension/manifest.json`. Permanent installation in Firefox Release requires
Mozilla signing. Each listed release is submitted to the Tab Gantry listing on Mozilla
Add-ons, becomes available there once Mozilla approves it, and is then published
as a GitHub Release; see [Releasing Tab Gantry](docs/releases.md). The toolbar popup
searches open group names, copies complete names, opens a selected group, and
shows a notice if grouping or naming fails. Details remain in the local extension
console.

Install from [Mozilla Add-ons](https://addons.mozilla.org/firefox/addon/tab-gantry/)
for automatic updates. Each listed release is also attached to its
[GitHub Release](https://github.com/Quince-Pie/tab-gantry/releases) as a
Mozilla-signed XPI; use Firefox's Add-ons Manager → Install Add-on From File.
It replaces an existing installation without uninstalling it.

### Chrome

Run `npm run build`, then open `chrome://extensions`, enable **Developer mode**,
choose **Load unpacked** and select `dist/chrome`. Released versions are
published to the Chrome Web Store ([publishing guide](docs/chrome-web-store.md)).
To group private tabs, allow the extension in Incognito in its details page.
Chrome shows the permission warnings "View and manage your tab groups" and "Read
your browsing history"; no URLs or page content are read.

## Generated names

New groups use one of 858 approved English adjective–noun pairs, such as
`sleepy-otter`. Selection avoids exact duplicates and defined spelling, sound and
meaning neighbors, and discourages repeated components. Its context is open
groups across windows of the same privacy class, plus 64 recent generated names.
When all eligible pairs are exhausted, `stack-N` provides an explicitly numbered
fallback. Search and copying work with either form.

Joining an existing group or preserving a child group during a late-parent merge
keeps that group's name, including a deliberately blank name. Rename or clear any
name in Firefox's group menu; Tab Gantry does not regenerate it later. Colors remain
native Firefox choices. Native session restore preserves completed names.

The `tabGroups` permission provides native group metadata. `storage` keeps only
bounded recent generated aliases and their window IDs in `storage.session`, with
separate normal/private histories. Private entries are removed on window closure;
all history clears on browser restart or add-on reload. No manual titles or page
contents are stored, and no data is sent. No `tabs`, host or clipboard permission
is needed. See [design and limits](docs/naming-design.md).

## Develop and verify

Use Node 24 LTS, npm, `zip`, Firefox **156**, and geckodriver. A pinned `flake.nix`
provides development tools on Linux; `nix develop` does not replace your installed
Firefox. The lockfile fixes both Nix and npm dependencies.

```sh
nix develop
npm ci
npm run check
npm run test:firefox
npm run test:metadata
npm run test:naming
npm run build
npm run test:package
```

Set `FIREFOX` to the Firefox 156 executable and `GECKODRIVER` to geckodriver if
needed. For Chrome, `npm run test:chrome` tests the built ZIP in the browser named
by `CHROME` (default `chromium`; 148 or later). `CHROME_VERSION` requires an
exact build, and `npm run benchmark:chrome` reproduces the
[Chrome measurements](docs/chrome.md#performance-qualification). Browser tests
create disposable profiles. They do not touch your profile.
`extension/` is directly loadable; JavaScript is checked with strict TypeScript
without a bundler or transpilation step. Build archives have sorted entries,
fixed timestamps and fixed file modes. The build checks that the editorial data,
compact runtime catalog and packaged CMU license agree. To intentionally edit the
word pack:

```sh
node naming-data/build-pack.mjs
node scripts/compile-names.js
npm run check:catalog
```

## Build from source

Mozilla reviewers receive this repository as each version's source archive.
Only `extension/name-catalog.js` is generated: `scripts/compile-names.js` writes
it from `naming-data/en-v1.json`, which `naming-data/build-pack.mjs` builds from
the editorial and pronunciation data in `naming-data/`. Every other packaged file
is hand-written and packaged unchanged, with no bundler, minifier or transpiler.

Building needs Node.js 24 and Info-ZIP `zip` 3.0, and no npm packages. It is
tested on Linux, where `nix develop` provides both tools.

```sh
node naming-data/build-pack.mjs --check  # the word pack matches its inputs
node scripts/compile-names.js --check    # name-catalog.js matches the word pack
node scripts/build.js                    # writes the XPI and Chrome ZIP to dist/
```

The build packages exactly the files in `extension/`, with sorted names, fixed
timestamps and 0644 modes, and prints the archive's SHA-256. The Chrome ZIP uses
the same files except Firefox's `manifest.json` and `background.js`, plus
`chrome/extension/` and a manifest derived from `chrome/manifest.json`; Chrome's
PNG icons are rendered from the SVG by `node scripts/render-chrome-icons.js`.
Files elsewhere are not packaged; `listing/icon.png` is the 128-pixel listing
icon uploaded to Mozilla Add-ons. Render it from `extension/icon.svg` with
`node scripts/render-listing-icon.js` using the documented Firefox toolchain.
`listing/chrome/` holds the Chrome Web Store small promo tile, rendered from the
SVG by `node scripts/render-chrome-promo.js`, and two 1280x800 screenshots taken
by `node scripts/capture-chrome-screenshots.js`. That script needs Xvfb and the
network: it drives a visible Chrome through live Wikipedia and Wikivoyage pages.
Listing artwork and frozen release packages are separate: a changed SVG ships in
the next version.

## CI and maintenance

[CI](.github/workflows/ci.yml) checks pull requests, `main`, merge queues and a
weekly UTC schedule. It uses the locked Nix toolchain and a verified Firefox
156.0 download, runs source/workflow/browser checks, and compares two builds of
each package. It also tests the Chrome ZIP in checksum-pinned Chrome for Testing
154 and in 148, the declared minimum. Successful runs provide the unsigned XPI
and the Chrome ZIP directly as artifacts, with separate diagnostics and
checksums. Artifacts expire after 14 days.

[Dependabot](.github/dependabot.yml) proposes weekly npm, Actions and Nix-lock
updates. Minor/patch updates are grouped; majors remain separately reviewable.
Updates require review and are not merged automatically. The Firefox baseline
and checksum-pinned Nix bootstrap are reviewed manually when changed.

Within `nix develop`, workflow checks are `node scripts/ci/check-workflows.js`,
`zizmor --offline --persona=pedantic .github/workflows`, and
`shellcheck scripts/ci/*.sh`. The Linux installer tests run with `npm run test:ci`.
The [CI record](docs/ci.md) explains the source/changelog audit, verification and
remaining GitHub-hosted execution boundary.

[Releasing Tab Gantry](docs/releases.md) starts with **Actions → Release**
(`prepare-release.yml`): enter the next unused version, approve CI if requested,
and merge the generated version PR. **Publish release** then verifies the merged
source, creates its tag and submits it to the existing Mozilla listing. After
Mozilla approves the version, it verifies the signed XPI in Firefox and publishes
an immutable GitHub Release. The same run submits the tested Chrome ZIP to the
Chrome Web Store with a short-lived, keyless credential; see
[Chrome Web Store publishing](docs/chrome-web-store.md). A run whose version
still awaits review ends successfully, and **Resume approved releases** completes
the GitHub publication after approval. Wait for Mozilla's decision before
merging the next release PR: submitting a new version would disable the pending
one, so the workflow refuses.
Do not create tags or GitHub Releases manually. The guide covers secrets,
repository settings, recovery, and the unusable `v1.1.1` release. Ordinary CI
runs remain read-only and do not release the extension.

The redesigned release controller has passed local and hosted CI. The
[acceptance record](docs/release-acceptance.md) tracks Mozilla approval, publication
and actual update delivery. Recovery uses reviewed controller code from `main`
against the frozen release source, including versions submitted by older tooling.

## Operational limits

Grouping is asynchronous. It re-reads endpoints and retries a failed operation
once. Closed, inaccessible, pinned or moved endpoints cancel that relationship;
other failures produce the toolbar notice. Windows progress independently.

Firefox exposes no atomic “group only if these tabs are still unpinned and in
this window” operation. An external pin/move between the final read and native
grouping can still race. Avoid combining automatic grouping extensions. This is
an API limitation, not an atomicity guarantee provided by the extension.

Title assignment and popup navigation have the same check/commit limitation:
observed edits cancel naming, but Firefox offers no conditional title write or
atomic validate-and-activate operation. Other writers can introduce duplicate
names. A crash or ambiguous creation reply can leave a group unnamed; Tab Gantry
does not infer ownership from a blank title. Storage failures are reported and
can defer private-history cleanup until a later operation or session termination.

Firefox 156 can also assign duplicate native group IDs. Tab Gantry detects observed
ambiguity and leaves affected names/membership unchanged; popup Open is disabled
for those groups. Use Firefox's tab strip to manage them. Mozilla's proposed fix
is still under review; see the [native-ID evidence](docs/naming-qualification.md#native-identity-discovery-and-guarded-failure-policy).

The same limitation and the private-group/current-window API bug are still
present in the supplied Firefox 156.0.1 and 158.0a1 sources. The extension handles
the privacy bug with a native tab-move fallback. No newer fix has been established;
[the version audit](docs/qualification.md) identifies the exact revisions to recheck.

Completed native groups survive normal Firefox session restore. A process crash,
disablement, or creation before event registration can lose pending relationship
events. Tab Gantry does not guess or retroactively reorganize existing tabs on
startup. Event-page sleep/wake is supported; it does not promise crash recovery
of events Firefox never delivered. See [qualification and evidence](docs/qualification.md)
for source versions, comparisons, exact verification coverage and claim limits.

The prior grouping qualification compared six designs in 1,080 samples, including
larger batches, window queries and dependency scheduling. Those measurements are
historical grouping evidence, not measurements of the new naming feature. See
[grouping measurements](docs/performance.md) and the new
[naming qualification](docs/naming-qualification.md) for verification, comparison
scope and actual limits. Selection follows your priority for lower state and
bounded work; no design is claimed universally fastest. The
[naming measurements](docs/naming-performance.md) compare six selectors and a
transient context cache on the delivered guarded pipeline.

Tab Gantry retains an exclusive child-branch group when its parent relationship arrives late,
preserving its identity, name, color, collapse and save-on-close setting. An existing
opener group always wins. If several child groups must merge, the first exclusive
group in event order survives; one group cannot preserve several different IDs.
Unrelated group members stay in their own group. See the [property audit](docs/metadata-review.md).

The supplied design is implemented and engineering-tested; the vocabulary and
similarity thresholds have not undergone a human outcome study. Better recall or
fewer wrong-group selections remain unestablished. The broader behavioral SOTA
claim is provisional, with a [fixed evaluation protocol](docs/naming-human-evaluation.md).

## License

Copyright (C) 2026 Quince Pie <pie@quince.org>.
Tab Gantry's original code and project-authored material are licensed under
[WTFPL, Version 2](LICENSE).

The CMU pronunciation data and derived metadata retain their separate
[CMU license](naming-data/CMU-LICENSE.txt), including its notice and disclaimer
requirements. Both license files are included in the extension package.
