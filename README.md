# Stackma

Automatic related-tab stacks for **Firefox desktop 156** using native tab groups.
Open a link in a new tab: it joins the opener's group, or starts a group with the
opener. Descendants stay together, including bursts of new tabs. New Stackma groups
receive a generated word-pair name. Firefox supplies the group menus, colors and
collapse controls; manual names remain yours.

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

## Install

For local use, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
Add-on**, and select `extension/manifest.json`. It starts immediately. Allow it in
private windows in Firefox's add-on settings if wanted. Temporary installation
lasts until Firefox restarts.

`npm run build` produces `dist/stackma-1.1.0.xpi`. Permanent installation in Firefox
Release requires Mozilla signing. This repository does not publish or submit the
extension. The toolbar popup searches open group names, copies complete names,
opens a selected group, and shows a notice if grouping or naming fails. Details
remain in the local extension console.

## Generated names

New groups use one of 858 approved English adjective–noun pairs, such as
`sleepy-otter`. Selection avoids exact duplicates and defined spelling, sound and
meaning neighbors, and discourages repeated components. Its context is open
groups across windows of the same privacy class, plus 64 recent generated names.
When all eligible pairs are exhausted, `stack-N` provides an explicitly numbered
fallback. Search and copying work with either form.

Joining an existing group or preserving a child group during a late-parent merge
keeps that group's name, including a deliberately blank name. Rename or clear any
name in Firefox's group menu; Stackma does not regenerate it later. Colors remain
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
needed. Browser tests create disposable profiles. They do not touch your profile.
`extension/` is directly loadable; JavaScript is checked with strict TypeScript
without a bundler or transpilation step. Build archives have sorted entries and
fixed timestamps. The build checks that the editorial data, compact runtime
catalog and packaged CMU license agree. To intentionally edit the word pack:

```sh
node naming-data/build-pack.mjs
node scripts/compile-names.js
npm run check:catalog
```

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
names. A crash or ambiguous creation reply can leave a group unnamed; Stackma
does not infer ownership from a blank title. Storage failures are reported and
can defer private-history cleanup until a later operation or session termination.

Firefox 156 can also assign duplicate native group IDs. Stackma detects observed
ambiguity and leaves affected names/membership unchanged; popup Open is disabled
for those groups. Use Firefox's tab strip to manage them. Mozilla's proposed fix
is still under review; see the [native-ID evidence](docs/naming-qualification.md#native-identity-discovery-and-guarded-failure-policy).

The same limitation and the private-group/current-window API bug are still
present in the supplied Firefox 156.0.1 and 158.0a1 sources. The extension handles
the privacy bug with a native tab-move fallback. No newer fix has been established;
[the version audit](docs/qualification.md) identifies the exact revisions to recheck.

Completed native groups survive normal Firefox session restore. A process crash,
disablement, or creation before event registration can lose pending relationship
events. Stackma does not guess or retroactively reorganize existing tabs on
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

Stackma retains an exclusive child-branch group when its parent relationship arrives late,
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
Stackma's original code and project-authored material are licensed under
[WTFPL, Version 2](LICENSE).

The CMU pronunciation data and derived metadata retain their separate
[CMU license](naming-data/CMU-LICENSE.txt), including its notice and disclaimer
requirements. Both license files are included in the extension package.
