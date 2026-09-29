# Chrome support

Tab Gantry runs in **Chrome 148 and later** on desktop, from the same grouping,
naming and popup code as Firefox. The Chrome package is published through the
Chrome Web Store; see [Chrome Web Store publishing](chrome-web-store.md). The
[evidence record](../evidence/chrome/qualification.json) links each claim below
to its source, observation or measurement.

## Minimum version

`chrome.tabGroups` exists from Chrome 89, but the extension also needs promise
returns from `tabGroups` (90), `storage.session` (102), and the standard
`browser.*` namespace. Chrome's
[transition guide](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace)
states that the namespace is available from Chrome 148 and tells new extensions to
set `minimum_chrome_version` to `"148"` and use `browser` unconditionally.
Tab Gantry follows that guidance.

The floor is checked, not assumed. The packaged ZIP passes the full browser suite
in Chrome for Testing 148.0.7778.178 and 154.0.8037.57. Chrome for Testing 147
refuses to load it ("requires … version 148 or greater"). With the floor removed
and field-trial testing configs disabled, Chrome 147 never starts the service
worker because `browser` is undefined there. Chromium and Chrome for Testing
builds otherwise apply field-trial *testing* configs that branded Chrome does not
(`components/variations/variations_switches.cc`), so every Chrome test here runs
with `--disable-field-trial-config`.

Supporting Chrome 123–147 would need a runtime `browser` alias plus testing on
those versions. That is a deliberate choice for existing user bases, not for a new
listing. Chrome users below the floor see "Not compatible" in the store.

## Package

`npm run build` writes `dist/tab-gantry-VERSION-chrome.zip` beside the XPI, plus
an unpacked `dist/chrome/` for chrome://extensions → **Load unpacked**. The build
packages the files in `extension/` except Firefox's `manifest.json` and
`background.js`, then adds `chrome/extension/` and a generated manifest:

- `chrome/manifest.json` supplies the Chrome keys. `version` comes from
  `extension/manifest.json`, so version PRs still change three files. The build
  rejects a name, permission or action that differs from Firefox's, a description
  over 132 characters, and a version Chrome cannot represent (components above
  65535).
- `chrome/extension/service-worker.js` is the Chrome entry. The shared wiring is
  in `extension/core.js`.
- Manifest icons are PNG because Chrome does not support SVG manifest icons.
  `node scripts/render-chrome-icons.js` renders them from `extension/icon.svg`.
  The 128px store icon keeps the artwork within the Web Store's 75–80% guidance.
  `chrome/icons.json` records the source digest, and the build refuses icons
  rendered from an older SVG.

Chrome shows two install warnings: "View and manage your tab groups"
(`tabGroups`) and "Read your browsing history" (`webNavigation`). Tab Gantry
reads no URLs or page content; `webNavigation` only identifies the tab a link
opened from. Chrome reports no install warnings, manifest errors or runtime
errors for the package in developer mode. The Firefox manifest is the negative
control: Chrome rejects its `background.scripts`.

## Differences from Firefox

**Link provenance.** Firefox reports the opening tab through both `tabs.onCreated`
and `webNavigation`, and the Firefox entry uses both. Chrome's `openerTabId` is a
tab-strip "return to" relationship. `TabStripModel::AddTab` gives the active tab
as opener to link tabs *and* to tabs opened at the end with a typed transition:
Ctrl+T, the New Tab button and Alt+Enter from the address bar. A real Ctrl+T in
Chrome 154 reports the active tab as its opener, as does `tabs.duplicate`. The
Chrome entry therefore uses only `webNavigation.onCreatedNavigationTarget`, which
Chrome raises only when a page frame opens a new tab or window
(`WebNavigationTabObserver::DidOpenRequestedURL`) and which names that frame's
tab. Its details carry no `windowId`, so the entry reads the new tab's window
before queueing. Real-browser tests cover `target=_blank`, `rel=noreferrer`,
`window.open`, iframe links and middle-click, and confirm that Ctrl+T and
duplicates stay unrelated. A tab another extension creates with
`tabs.create({openerTabId})` is not grouped in Chrome: that opener is not
link provenance either.

**Native inheritance.** Chrome itself places a link opened from a grouped tab into
that group. Tab Gantry leaves the membership and the group's name alone, as it
does in Firefox.

**Errors.** Chrome answers a closed tab with `No tab with id: N.` and a closed group
with `No group with id: N.`. The stacker treats both browsers' messages as
cancellation rather than failure.

**Ordering.** The namer requires a group's own `tabGroups.onCreated` event to
arrive before `tabs.group` resolves. Chrome creates the group inside
`AddTabsToGroup`, broadcasting synchronously to a ready worker, then calls
`RespondNow`. The worker's event dispatcher is an endpoint on the same associated
pipe as its API replies, so the event precedes the reply. A probe observed that
order in 60 of 60 creations.

**Private windows.** Chrome runs the extension in incognito only when the user
allows it. The manifest declares the default `"spanning"` mode, so one worker
sees both kinds of window, as the namer's separate private history requires.
Firefox's private-window fallback is never needed: Chrome groups with an
explicit window or group ID while a normal window is focused.

**Group IDs.** Chrome derives each group ID from a 31-bit hash of the group's
token (`ExtensionTabUtil::GetGroupId`). A collision is improbable, but the existing
duplicate-ID guard also covers it.

**Split view.** Chrome's `tabs.group` adds a split tab's companion, as Firefox
does. Chrome 154 cannot create a split view from an extension (`tabs.createSplit`
arrives in 155), so this path is covered by source only, not by a Chrome test.

## Verification

```sh
npm run build
CHROME=/path/to/chrome npm run test:chrome -- --output=artifacts/chrome-tests.json
```

`scripts/chrome-test.js` installs the exact ZIP through the DevTools protocol.
Chrome 137 removed `--load-extension` from branded builds, so it uses
`Extensions.loadUnpacked` over `--remote-debugging-pipe`. The script checks every
packaged file against the source, Chrome's own diagnostics, and 14 real-browser
behaviors:

- the link variants, Ctrl+T, duplicates, pinned tabs and separate windows
- a manually named group, a four-link burst, and a stopped service worker woken
  by a link
- a private window's naming and cleanup
- the popup's list, search, copy and Open

Set `CHROME_VERSION` to require an exact build. CI installs checksum-pinned
Chrome for Testing 154.0.8037.57 and 148.0.7778.178 and runs the suite on both.
A deliberate mutation that gives Chrome Firefox's `openerTabId` wiring fails the
Ctrl+T test.

## Performance qualification

Chrome's API costs differ from Firefox's. In Chromium 154, `tabs.get` scans every
window and tab, and a miss also walks renderer frames looking for prerendered
tabs. `tabGroups.get` hashes each group's token. A cold extension service worker
starts in roughly 20–30 ms. The Firefox measurements do not transfer to Chrome,
so the two Chrome-specific decisions were measured in Chrome:

- the window lookup the Chrome entry adds
- whether the Firefox-selected stacker remains appropriate

The confirmation runs of the delivered sources used Chrome for Testing
154.0.8037.57 with field-trial testing configs disabled, on an AMD Ryzen 9
9950X3D (32 logical CPUs, Linux 6.18.52), on 2026-09-29. Exploratory runs chose
nothing and are kept separately. The tables are the final run on the delivered
sources. The initial confirmation preceded message-only source edits and is kept
beside it.
The rule was fixed before confirmation. A challenger counts as materially faster
in a scenario only with a median at least 20% lower **and** at least 10 of 12
rotation-paired blocks. Selection keeps the project's priority: lower retained
state, then bounded work, then latency. Figures are medians [minimum–maximum] in
milliseconds over 12 blocks. They are not confidence intervals or tail guarantees.

### Chrome entry: window lookup or a creation-event cache

The measurement starts at a real link click in the page and ends when the tab
joins a group and when that group has its generated name. Each sample freshly
installs one variant and discards one warm run.

- **lookup** (delivered): a `tabs.get` per navigation target.
- **cache**: records each tab's window from `tabs.onCreated`, falling back to
  `tabs.get` when the cache has no entry.

| Window tabs / scenario | Grouped: lookup | Grouped: cache | Grouped and named: lookup | Grouped and named: cache |
| --- | ---: | ---: | ---: | ---: |
| 2 / single | 22.1 [18.8–31.3] | 21.5 [14.0–27.9] | 32.6 [26.5–42.5] | 34.2 [25.5–52.2] |
| 40 / single | 22.6 [18.0–24.3] | 17.1 [14.0–22.9] | 33.2 [26.5–37.0] | 32.8 [26.7–35.6] |
| 512 / single | 41.5 [37.7–46.6] | 39.2 [21.6–48.2] | 53.5 [44.6–59.6] | 51.8 [45.0–56.5] |
| 40 / burst of 8 | 38.8 [33.2–54.5] | 38.4 [32.6–46.4] | 139.2 [128.8–145.5] | 138.0 [121.8–144.0] |
| 40 / stopped worker | 33.0 [30.7–45.7] | 35.4 [30.4–52.4] | 41.9 [34.8–52.4] | 45.9 [38.4–64.8] |
| 512 / stopped worker | 55.0 [47.3–56.6] | 54.2 [47.2–57.6] | 65.7 [59.2–68.9] | 63.2 [58.6–68.8] |

The cache forms the group sooner at 40 tabs: 17.1 against 22.6 ms. That is 24%
lower with 11/12 blocks in this run, and 19% with 11/12 in the
[first confirmation](../evidence/chrome/benchmark-entry-confirmation-initial.json).
The second run crossed the threshold; the first missed it. The effect disappears
by the time the name is written: for the complete outcome, grouped and named, no
difference is material in either run, and the cache is slower after a stopped
40-tab worker. The costs differ in kind:

- **The cache** adds retained state and receives every tab creation. With the
  worker asleep, 20 unrelated Ctrl+T tabs started it once and delivered 20
  events.
- **The lookup** caused no start and received no event. It pays one extra
  `tabs.get` per link, and in an 8-link burst coalesces less (20 reads and 3
  group calls against 12 and 2).

The recorded priority ranks state first, so the lookup is retained. The ~5 ms
earlier group formation at 40 tabs is a real trade-off, not a tie.

### Stacker on Chrome

This is the Firefox admission benchmark ported to Chrome: the same six
candidates, scenarios and rotating order. Tabs exist in advance, and each sample
covers everything from queueing the relations to native completion.

| Window tabs / scenario | FIFO (1) | Selected (32) | Batch 128 | Window query | Query ≥16 | Dependency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 / single | 0.7 [0.6–2.6] | 0.7 [0.6–5.3] | 0.6 [0.5–0.8] | 0.7 [0.5–2.2] | 0.7 [0.6–1.0] | 0.7 [0.5–1.0] |
| 33 / siblings32 | 26.6 [20.5–28.3] | 4.0 [3.7–5.4] | 4.0 [3.8–9.5] | 4.0 [3.5–5.3] | 4.3 [3.7–5.5] | 4.2 [3.7–5.7] |
| 40 / single | 0.9 [0.8–2.3] | 0.9 [0.7–4.2] | 0.9 [0.7–1.0] | 1.3 [1.0–6.3] | 0.9 [0.8–1.3] | 0.9 [0.7–2.7] |
| 40 / siblings32 | 16.8 [12.7–27.5] | 3.8 [3.5–4.1] | 3.9 [3.6–6.1] | 3.7 [3.4–5.6] | 3.5 [3.2–4.0] | 3.8 [3.4–6.3] |
| 40 / chain32 | 16.8 [12.5–19.2] | 16.8 [12.1–18.1] | 16.5 [14.5–18.6] | 24.1 [22.6–27.6] | 16.4 [12.0–17.6] | 16.4 [11.7–18.9] |
| 40 / independent16 | 44.4 [37.5–49.5] | 43.6 [38.8–51.5] | 45.4 [37.1–50.8] | 51.0 [48.2–56.6] | 45.8 [38.4–49.3] | 17.6 [16.5–18.9] |
| 512 / single | 6.5 [5.5–7.5] | 6.3 [5.7–7.0] | 6.7 [5.4–10.7] | 14.5 [12.5–15.3] | 6.7 [6.0–7.4] | 6.5 [6.1–6.9] |
| 512 / siblings32 | 38.5 [36.1–43.4] | 15.1 [14.2–18.7] | 15.9 [14.2–20.6] | 20.7 [19.6–25.0] | 21.8 [20.2–23.6] | 15.2 [14.1–16.4] |
| 512 / siblings128 | 154.5 [129.0–178.0] | 83.3 [78.8–94.4] | 44.1 [40.0–50.6] | 105.3 [94.0–113.0] | 106.1 [100.4–111.0] | 85.0 [74.7–94.7] |

Despite Chrome's per-call scan, per-tab reads beat window queries at 512 tabs,
because a window query returns every tab object. Two challengers are materially
faster, each in one simultaneous burst, with 12/12 blocks:

- **Dependency scheduling**, for 16 independent relationships at once: 60% lower
  (62% in the first run). Its margin in Firefox was 16%. It retains per-component
  membership.
- **Batch 128**, for 128 siblings from one tab: 47% lower. Its work bound is 129
  records per read phase instead of 33.

Both costs are exactly what the recorded priority ranks first, so the selected
design stands for both browsers. Neither burst is produced by one person clicking
links. If latency in such bursts should outrank retained state, dependency
scheduling is the change to evaluate, and the shared kernel would change for
Firefox as well.

The naming decisions were not re-measured in Chrome. The Firefox
[naming qualification](naming-performance.md) chose the selector and fresh
per-assignment context by the same state-first rule. Their retained state and
work bounds are properties of the code, not the browser, so Chrome latency cannot
reverse those choices. End-to-end naming time in Chrome is included in the
"grouped and named" column above.

### Considered and not adopted

- **Registering listeners only while state exists**, to avoid waking a sleeping
  worker. Chromium registers every service-worker listener as a persistent lazy
  listener whenever it is added, so late registration saves nothing. Dynamic
  removal would endanger the namer's rename-cancellation detection, and dropping
  `tabs.onRemoved` would leave the stacker's state unbounded during long sessions.
  Its resource effect is not measured.
- **Prefetching both endpoints at admission** to save the stacker's first read.
  At most it removes the round trip measured above, and it weakens the stacker's
  processing-time freshness.

Reproduce: `npm run benchmark:chrome` with `CHROME` set. Reports are written to
`artifacts/`. The confirmation reports, exploratory reports and browser test
reports are in [evidence/chrome](../evidence/chrome/).

## Limits

- [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) is
  Google's versioned flavor of Chrome, "as close to regular Chrome as possible",
  without auto-update. Results in auto-updating Google Chrome are expected to
  match but were not separately measured.
- Chromium-source claims are for 154.0.8037.57; 148 is covered by the behavioral
  suite, not by a separate source audit.
- Context-menu "Open link in new tab" goes through the same `DidOpenRequestedURL`
  path but is not driven by the browser tests.
- The timings exclude paint and are 12-block descriptive samples; they do not
  establish that any design is fastest for every workload.
