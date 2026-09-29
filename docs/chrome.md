# Chrome support

Tab Gantry runs in **Chrome 148 and later** on desktop, from the same grouping,
naming and popup code as Firefox.

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

Set `CHROME_VERSION` to require an exact build. A deliberate mutation that gives
Chrome Firefox's `openerTabId` wiring fails the Ctrl+T test.

## Limits

- [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) is
  Google's versioned flavor of Chrome, "as close to regular Chrome as possible",
  without auto-update. Results in auto-updating Google Chrome are expected to
  match but were not separately measured.
- Chromium-source claims are for 154.0.8037.57; 148 is covered by the behavioral
  suite, not by a separate source audit.
- Context-menu "Open link in new tab" goes through the same `DidOpenRequestedURL`
  path but is not driven by the browser tests.
