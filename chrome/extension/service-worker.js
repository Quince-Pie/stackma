import { start } from "./core.js";
import { missingTab } from "./stacker.js";

const { stacker, onError } = start(browser);

// Chrome's tabs.onCreated openerTabId is not link provenance: a new tab opened
// at the end of the strip with a typed transition (Ctrl+T, the New Tab button,
// Alt+Enter) inherits the active tab as its opener (TabStripModel::AddTab).
// Navigation targets come only from a frame that opened the tab and name that
// frame's tab, but carry no windowId; read the new tab's window instead.
browser.webNavigation.onCreatedNavigationTarget.addListener(details => {
  void browser.tabs.get(details.tabId).then(
    tab => stacker.enqueue({
      tabId: details.tabId, sourceTabId: details.sourceTabId, windowId: /** @type {number} */ (tab.windowId),
    }),
    error => { if (!missingTab(error)) onError(error); },
  );
});
