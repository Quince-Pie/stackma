import { createStacker } from "./stacker.js";
import { createNamer } from "./namer.js";
import { createGroupIdGuard } from "./group-id-guard.js";

/**
 * Wire grouping and naming to native group, window and tab-removal events.
 * Each browser's entry point then registers the relationship signals that
 * browser defines as link provenance, using the returned stacker.
 *
 * Listeners are registered synchronously, before any initialization IPC, so an
 * event that wakes the event page or service worker reaches them.
 * @param {typeof browser} api
 */
export function start(api) {
  /** @param {unknown} error */
  function onError(error) {
    console.error("Tab Gantry: grouping or naming could not finish", error);
    void api.action.setBadgeBackgroundColor({ color: "#b42318" }).catch(console.error);
    void api.action.setBadgeText({ text: "!" }).catch(console.error);
  }

  const ids = createGroupIdGuard(api);
  const namer = createNamer({
    windows: api.windows,
    storage: api.storage,
    tabGroups: { get: api.tabGroups.get, query: ids.query, update: api.tabGroups.update },
  }, { onError });
  const stacker = createStacker(api, {
    onError, onGroupCreated: namer.enqueue, validateGroupIds: ids.validate,
  });

  api.tabGroups.onUpdated.addListener(namer.updated);
  api.tabGroups.onCreated.addListener(group => { ids.invalidate(); namer.created(group); });
  api.tabGroups.onRemoved.addListener(group => { ids.invalidate(); namer.removed(group); });
  api.tabGroups.onMoved.addListener(group => { ids.invalidate(); namer.moved(group); });
  api.windows.onCreated.addListener(ids.invalidate);
  api.windows.onRemoved.addListener(windowId => { ids.invalidate(); return namer.closedWindow(windowId); });
  api.tabs.onRemoved.addListener(tabId => stacker.forget(tabId));
  return { stacker, onError };
}
