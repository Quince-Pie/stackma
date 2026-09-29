import { start } from "./core.js";

const { stacker } = start(browser);

// Firefox reports link provenance through both creation APIs; neither covers
// every native path alone (docs/qualification.md, "Link causality").
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
