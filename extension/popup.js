/** @typedef {Pick<typeof browser, 'action' | 'tabGroups' | 'tabs' | 'windows'>} PopupAPI */
/** @typedef {{group: browser.tabGroups.TabGroup, row: HTMLLIElement, open: HTMLButtonElement, copy: HTMLButtonElement}} GroupRow */

/**
 * Read native metadata only while the popup is open. Native IDs, never names or
 * search results, identify navigation targets. Check the title as well so a stale
 * rendered label cannot select a newly renamed group.
 * @param {PopupAPI} api
 * @param {Document} doc
 * @param {Pick<Clipboard, 'writeText'>} clipboard
 * @param {() => void} closePopup
 */
export function createPopup(api, doc, clipboard, closePopup) {
  const search = /** @type {HTMLInputElement} */ (doc.querySelector("#search"));
  const list = /** @type {HTMLUListElement} */ (doc.querySelector("#groups"));
  const count = /** @type {HTMLElement} */ (doc.querySelector("#result-count"));
  const message = /** @type {HTMLElement} */ (doc.querySelector("#message"));
  const issue = /** @type {HTMLElement} */ (doc.querySelector("#issue"));
  const dismiss = /** @type {HTMLButtonElement} */ (doc.querySelector("#dismiss"));
  const heading = /** @type {HTMLElement} */ (doc.querySelector("#groups-heading"));
  /** @type {GroupRow[]} */
  let rows = [];
  /** @type {Set<number>} */
  let ambiguous = new Set();
  /** @type {Map<number, string>} */
  const windowLabels = new Map();
  let nextWindowLabel = 1;
  let opening = false;
  let dirty = false;
  /** @type {Promise<void> | undefined} */
  let refreshing;
  const owner = api.windows.getCurrent();
  const ambiguousMessage = "Firefox cannot distinguish some groups. Open those groups from Firefox’s tab bar.";

  /** @param {string} text @param {boolean} [error] */
  function notify(text, error = false) {
    message.textContent = text;
    message.dataset.error = String(error);
  }

  function filter() {
    const query = search.value.trim().toLocaleLowerCase("en");
    let visible = 0;
    for (const { group, row } of rows) {
      row.hidden = !(group.title ?? "").toLocaleLowerCase("en").includes(query);
      if (!row.hidden) visible++;
    }
    count.textContent = visible ? `${visible} ${visible === 1 ? "group" : "groups"}` :
      query ? "No group names match." : "No open groups in these windows.";
  }

  /** @param {browser.tabGroups.TabGroup} before @param {browser.tabGroups.TabGroup} after */
  function sameGroup(before, after) {
    return before.id === after.id && before.windowId === after.windowId &&
      (before.title ?? "") === (after.title ?? "");
  }

  /** Firefox 156 can issue duplicate native group IDs. Check all accessible
   * groups before filtering privacy; a cross-window duplicate is ambiguous too.
   * @param {browser.tabGroups.TabGroup[]} groups
   */
  function ambiguousIds(groups) {
    const seen = new Set();
    const duplicates = new Set();
    for (const { id } of groups) {
      if (seen.has(id)) duplicates.add(id);
      else seen.add(id);
    }
    return duplicates;
  }

  /** @param {browser.tabGroups.TabGroup} rendered */
  async function openGroup(rendered) {
    if (opening || ambiguous.has(rendered.id)) return;
    opening = true;
    for (const row of rows) row.open.disabled = true;
    try {
      const current = await api.tabGroups.get(rendered.id);
      if (!sameGroup(rendered, current)) {
        notify("This group changed. The list has been refreshed; choose it again.", true);
        await requestRefresh();
        return;
      }
      const scope = await owner;
      const members = await api.tabs.query({ groupId: current.id, windowId: current.windowId });
      /** @type {browser.tabs.Tab | undefined} */
      let selected;
      for (const tab of members) {
        if (tab.groupId !== current.id || tab.windowId !== current.windowId || tab.incognito !== scope.incognito || tab.id === undefined) continue;
        if (!selected || tab.active && !selected.active || tab.active === selected.active && tab.index < selected.index) selected = tab;
      }
      if (selected?.id === undefined) {
        notify("This group no longer has an available tab. The list has been refreshed.", true);
        await requestRefresh();
        return;
      }
      const [latest, tab, window, groups] = await Promise.all([
        api.tabGroups.get(current.id), api.tabs.get(selected.id), api.windows.get(current.windowId),
        api.tabGroups.query({}),
      ]);
      const matches = groups.filter(group => group.id === current.id);
      if (matches.length > 1) {
        notify(ambiguousMessage, true);
        await requestRefresh();
        return;
      }
      if (matches.length !== 1 || !sameGroup(rendered, matches[0]) || !sameGroup(rendered, latest) || tab.groupId !== current.id ||
        tab.windowId !== current.windowId || tab.incognito !== scope.incognito || window.incognito !== scope.incognito) {
        notify("This group changed. The list has been refreshed; choose it again.", true);
        await requestRefresh();
        return;
      }
      await api.tabs.update(selected.id, { active: true });
      await api.windows.update(current.windowId, { focused: true });
      closePopup();
    } catch (error) {
      console.error("Stackma: could not open the selected group", error);
      notify("Could not open this group. The list has been refreshed; try again.", true);
      await requestRefresh();
    } finally {
      opening = false;
      for (const row of rows) row.open.disabled = ambiguous.has(row.group.id);
    }
  }

  /** @param {browser.tabGroups.TabGroup[]} groups @param {browser.windows.Window} scope */
  function render(groups, scope) {
    const focused = doc.activeElement;
    const focusId = focused?.getAttribute("data-group-id");
    const focusAction = focused?.getAttribute("data-action");
    rows = groups.map(group => {
      const title = group.title ?? "";
      const display = title || "Unnamed group";
      const row = doc.createElement("li");
      row.className = "group";
      const name = doc.createElement("span");
      name.className = "group-name";
      name.textContent = display;
      const details = doc.createElement("p");
      details.className = "group-details";
      details.textContent = `${group.windowId === scope.id ? "This window" : windowLabels.get(group.windowId)} · ${group.color} · ${group.collapsed ? "Collapsed" : "Expanded"}`;
      const actions = doc.createElement("div");
      actions.className = "group-actions";
      const open = doc.createElement("button");
      open.type = "button";
      open.textContent = "Open group";
      open.setAttribute("aria-label", `Open ${display}, ${details.textContent}`);
      open.dataset.groupId = String(group.id);
      open.dataset.action = "open";
      open.disabled = opening || ambiguous.has(group.id);
      open.addEventListener("click", () => { void openGroup(group); });
      const copy = doc.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy name";
      copy.setAttribute("aria-label", `Copy name: ${display}`);
      copy.dataset.groupId = String(group.id);
      copy.dataset.action = "copy";
      copy.disabled = !title;
      // Synchronous call inside the click retains transient user activation.
      // Copy the rendered title exactly, not a newer or approximately matched one.
      copy.addEventListener("click", () => {
        try {
          void clipboard.writeText(title).then(
            () => notify("Group name copied."),
            error => {
              console.error("Stackma: could not copy the group name", error);
              notify("Could not copy. Select the displayed name and copy it manually.", true);
            },
          );
        } catch (error) {
          console.error("Stackma: could not copy the group name", error);
          notify("Could not copy. Select the displayed name and copy it manually.", true);
        }
      });
      actions.append(open, copy);
      row.append(name, details, actions);
      return { group, row, open, copy };
    });
    const fragment = doc.createDocumentFragment();
    for (const { row } of rows) fragment.append(row);
    list.replaceChildren(fragment);
    filter();
    if (focusId && focusAction) {
      const restored = rows.find(row => String(row.group.id) === focusId && !row.row.hidden && !ambiguous.has(row.group.id));
      if (restored) {
        const control = focusAction === "copy" ? restored.copy : restored.open;
        control.focus({ preventScroll: true });
        control.scrollIntoView({ block: "nearest" });
      } else search.focus();
    }
  }

  async function refresh() {
    while (dirty) {
      dirty = false;
      try {
        const [scope, windows, groups] = await Promise.all([
          owner, api.windows.getAll(), api.tabGroups.query({}),
        ]);
        if (dirty) continue;
        ambiguous = ambiguousIds(groups);
        heading.textContent = scope.incognito ? "Open private groups" : "Open groups";
        const permitted = new Set(windows.filter(window => window.incognito === scope.incognito).map(window => window.id));
        for (const id of windowLabels.keys()) {
          if (!permitted.has(id)) windowLabels.delete(id);
        }
        for (const window of windows.toSorted((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
          if (window.id !== undefined && window.id !== scope.id && permitted.has(window.id) && !windowLabels.has(window.id)) {
            windowLabels.set(window.id, `Window ${nextWindowLabel++}`);
          }
        }
        const visible = groups.filter(group => permitted.has(group.windowId)).toSorted((a, b) =>
          Number(b.windowId === scope.id) - Number(a.windowId === scope.id) || a.windowId - b.windowId || a.id - b.id);
        render(visible, scope);
        if (visible.some(group => ambiguous.has(group.id))) notify(ambiguousMessage, true);
        else if (message.textContent === ambiguousMessage) notify("");
      } catch (error) {
        console.error("Stackma: could not read groups", error);
        rows = [];
        list.replaceChildren();
        count.textContent = "Groups are unavailable.";
        notify("Could not read groups. Reopen Stackma to try again.", true);
      }
    }
  }

  function requestRefresh() {
    dirty = true;
    refreshing ??= Promise.resolve().then(refresh).finally(() => {
      refreshing = undefined;
      if (dirty) void requestRefresh();
    });
    return refreshing;
  }

  search.addEventListener("input", filter);
  for (const event of [api.tabGroups.onCreated, api.tabGroups.onUpdated, api.tabGroups.onMoved, api.tabGroups.onRemoved]) {
    event.addListener(requestRefresh);
  }
  api.windows.onCreated.addListener(requestRefresh);
  api.windows.onRemoved.addListener(requestRefresh);
  dismiss.addEventListener("click", () => {
    dismiss.disabled = true;
    void api.action.setBadgeText({ text: "" }).then(
      () => { issue.hidden = true; },
      error => {
        console.error("Stackma: could not dismiss the notice", error);
        notify("Could not dismiss the notice. Try again.", true);
      },
    ).finally(() => { dismiss.disabled = false; });
  });
  const badge = api.action.getBadgeText({}).then(
    text => { issue.hidden = text !== "!"; },
    error => {
      console.error("Stackma: could not read the notice", error);
      notify("Could not read Stackma’s latest status.", true);
    },
  );
  void requestRefresh();
  return {
    refresh: requestRefresh,
    async idle() { await badge; while (refreshing) await refreshing; },
  };
}

if (typeof document !== "undefined" && typeof browser !== "undefined") {
  createPopup(browser, document, navigator.clipboard, () => window.close());
}
