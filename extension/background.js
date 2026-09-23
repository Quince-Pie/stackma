import { createStacker } from "./stacker.js";
import { createNamer } from "./namer.js";
import { createGroupIdGuard } from "./group-id-guard.js";

/** @param {unknown} error */
function onError(error) {
  console.error("Stackma: grouping or naming could not finish", error);
  void browser.action.setBadgeBackgroundColor({ color: "#b42318" }).catch(console.error);
  void browser.action.setBadgeText({ text: "!" }).catch(console.error);
}

const ids = createGroupIdGuard(browser);
const namer = createNamer({
  windows: browser.windows,
  storage: browser.storage,
  tabGroups: { get: browser.tabGroups.get, query: ids.query, update: browser.tabGroups.update },
}, { onError });
const stacker = createStacker(browser, {
  onError, onGroupCreated: namer.enqueue, validateGroupIds: ids.validate,
});

// Register persistent listeners synchronously, before any initialization IPC.
browser.tabGroups.onUpdated.addListener(namer.updated);
browser.tabGroups.onCreated.addListener(group => { ids.invalidate(); namer.created(group); });
browser.tabGroups.onRemoved.addListener(group => { ids.invalidate(); namer.removed(group); });
browser.tabGroups.onMoved.addListener(group => { ids.invalidate(); namer.moved(group); });
browser.windows.onCreated.addListener(ids.invalidate);
browser.windows.onRemoved.addListener(windowId => { ids.invalidate(); return namer.closedWindow(windowId); });

browser.tabs.onCreated.addListener(tab => stacker.enqueue({
  tabId: /** @type {number} */ (tab.id),
  sourceTabId: /** @type {number} */ (tab.openerTabId),
  windowId: /** @type {number} */ (tab.windowId),
}));

browser.webNavigation.onCreatedNavigationTarget.addListener(details => stacker.enqueue({
  tabId: details.tabId,
  sourceTabId: details.sourceTabId,
  windowId: /** @type {typeof details & {windowId: number}} */ (details).windowId,
}));

browser.tabs.onRemoved.addListener(tabId => stacker.forget(tabId));
