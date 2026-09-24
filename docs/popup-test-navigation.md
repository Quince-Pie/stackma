# Popup test navigation synchronization

The hosted CI run for `fc63129a10b7c548bcf6c96eb65a7f7b931f315f` failed
`popup-opens-the-explicitly-selected-native-group` with `Document was unloaded`.
The preceding 20 grouping, eight metadata and 14 naming/popup cases passed.
The supplied log is identified by its digest in the accompanying evidence.

The test called `tabs.create()` and immediately installed an asynchronous DOM
poll in that tab's current document. Creation does not imply navigation completion:
the current document can still be the initial `about:blank`. Its replacement
rejects that poll. Firefox 156 deliberately reports `Document was unloaded` from
Marionette's unload handler; process changes can instead report a destroyed actor.
An unchanged local run reproduced the actor-destruction variant in the privacy
popup case, and a controlled replacement reproduced the exact unload message.

`createLoadedPopup()` now registers filtered completion/error listeners before
creation. Separate promises correlate even early events with the returned tab ID.
Only completion of the requested top-level popup URL admits DOM inspection; the
existing group-rendering wait and selection/copy/privacy assertions still apply.
The five-second deadline covers both creation and navigation. All registered
listeners and the deadline timer are removed on success and failure. The helper
uses existing permissions and does not change window focus. Test failure reports
now retain the client stack as well as the remote stack, and record the helper's
source digest.

## Source and choice

The scope is the existing Firefox 156 test harness, with unchanged extension code
and assertions. Correct document identity, original focus/privacy conditions,
failure propagation and bounded cleanup take priority over implementation size.
Investigation and verification used a 40-minute budget starting 2026-09-24
02:19:12 UTC; local baseline/prototype reports remain in `artifacts/popup-unload/`.

The supplied Firefox checkout is newer than the target. The affected mechanisms
were therefore checked at the exact Firefox 156 revision
`3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1`:

- [Tab creation](https://github.com/mozilla-firefox/firefox/blob/3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1/browser/components/extensions/parent/ext-tabs.js): returns immediately after creating/selecting a tab, without waiting for load completion.
- [Marionette evaluation](https://github.com/mozilla-firefox/firefox/blob/3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1/remote/marionette/evaluate.sys.mjs): an unload handler rejects the pending script.
- [Navigation events](https://github.com/mozilla-firefox/firefox/blob/3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1/toolkit/components/extensions/WebNavigation.sys.mjs): successful window `STATE_STOP` emits `onCompleted`; failures emit `onErrorOccurred`.
- [Event API adapter](https://github.com/mozilla-firefox/firefox/blob/3bf8f468258c2181f455e23d4ffcd6acb8f4cdb1/toolkit/components/extensions/parent/ext-webNavigation.js): applies URL/private-tab access filters, supplies tab/frame IDs, and unregisters listeners.

[MDN's creation contract](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create#return_value)
explicitly recommends registering completion listeners before creating the tab.

A WebDriver `Navigate To` prototype passed the popup assertions, but changed
window focus, including with a non-focusing `Switch To Window`. That weakened the
background-window privacy setup. It was rejected; the driver changes were reverted,
and an explicit focus-preservation assertion was retained. An arbitrary delay
does not establish document readiness. Retrying arbitrary failed scripts could
repeat their side effects. The selected event gate preserves the original setup
and propagates actual loading failures.

## Verification and reproduction

Six portable tests cover early completion, unrelated events, load/creation errors,
stalled operations and partial registration cleanup. The browser regression starts
the old poll in `about:blank`, confirms it entered, then navigates; only the known
unload/actor-destruction failure is accepted for that deliberately broken control.
It then verifies the corrected helper's document, ready state and group rows in
both normal and private windows.

Inside `nix develop`:

```sh
node --test tests/popup-tab.test.js
node scripts/naming-test.js --output=artifacts/naming-tests.json
```

[Evidence](../evidence/popup-navigation.json) records the final revision's file
hashes, ten fresh Firefox sessions (160 cases), existing checks and source scope.
Those repetitions are regression evidence, not a statistical guarantee of zero
future failures or a performance claim. The fixed revision still needs a hosted
CI run. Rerunning the old run at `fc63129` continues to execute the old test;
commit and push the fix, then check CI on the new commit.
