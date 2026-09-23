// Independent, deliberately small model of the Firefox 156 tab operations used
// by the stacker. API calls cross an asynchronous boundary; validation and the
// resulting native mutation are atomic. This is not a browser or split-view
// emulator. Real-browser tests own those additional platform claims.

export function createModel(initialTabs, options = {}) {
  const records = new Map();
  const windows = new Map();
  const groups = new Map();
  const calls = [];
  const faults = { get: [], query: [], group: [], move: [] };
  const holds = [];
  let currentWindowId = options.currentWindowId ?? initialTabs[0]?.windowId ?? 1;
  let nextGroupId = 100;

  for (const input of initialTabs) {
    const tab = {
      groupId: -1,
      pinned: false,
      active: false,
      incognito: false,
      cookieStoreId: 'firefox-default',
      ...input,
    };
    if (records.has(tab.id)) throw new Error(`Duplicate model tab: ${tab.id}`);
    records.set(tab.id, tab);
    if (!windows.has(tab.windowId)) {
      windows.set(tab.windowId, { incognito: tab.incognito, order: [] });
    }
    windows.get(tab.windowId).order.push(tab.id);
    if (tab.groupId !== -1) {
      groups.set(tab.groupId, { id: tab.groupId, windowId: tab.windowId, title: '', color: 'blue', collapsed: false, saveOnWindowClose: true });
      nextGroupId = Math.max(nextGroupId, tab.groupId + 1);
    }
  }
  for (const win of windows.values()) {
    win.order.sort((a, b) => (records.get(a).index ?? 0) - (records.get(b).index ?? 0));
  }
  reindex();

  function reindex() {
    for (const [windowId, win] of windows) {
      win.order.forEach((id, index) => Object.assign(records.get(id), { windowId, index }));
    }
    for (const id of groups.keys()) {
      if (![...records.values()].some(tab => tab.groupId === id)) groups.delete(id);
    }
  }

  function requireTab(id) {
    const tab = records.get(id);
    if (!tab) throw new Error(`Invalid tab ID: ${id}`);
    return tab;
  }

  function snapshotTab(id) {
    const tab = { ...requireTab(id) };
    const opener = records.get(tab.openerTabId);
    if (!opener || opener.windowId !== tab.windowId) delete tab.openerTabId;
    return tab;
  }

  async function boundary(method, args) {
    const call = { method, args: structuredClone(args) };
    calls.push(call);
    const index = holds.findIndex(hold => hold.method === method && hold.predicate(call.args));
    if (index !== -1) {
      const [hold] = holds.splice(index, 1);
      hold.enter.resolve(call);
      await hold.resume.promise;
    }
    await options.beforeCall?.(call, model);
    const error = faults[method].shift();
    if (error) throw error;
  }

  function detach(ids) {
    const selected = new Set(ids);
    for (const win of windows.values()) win.order = win.order.filter(id => !selected.has(id));
  }

  function memberIds(groupId) {
    const group = groups.get(groupId);
    if (!group) return [];
    return windows.get(group.windowId).order.filter(id => records.get(id).groupId === groupId);
  }

  function nativeGroup(groupOptions) {
    const ids = [...new Set(Array.isArray(groupOptions.tabIds) ? groupOptions.tabIds : [groupOptions.tabIds])];
    if (!ids.length) throw new Error('At least one tab ID is required');
    const tabs = ids.map(requireTab);
    if (groupOptions.groupId != null && groupOptions.createProperties != null) {
      throw new Error('createProperties cannot be combined with groupId');
    }
    const windowId = groupOptions.createProperties?.windowId ?? currentWindowId;
    const currentWindow = windows.get(windowId);
    if (!currentWindow) throw new Error(`Invalid window ID: ${windowId}`);
    for (const tab of tabs) {
      if (tab.incognito !== currentWindow.incognito) {
        throw new Error(currentWindow.incognito
          ? 'Cannot move non-private tabs to private window'
          : 'Cannot move private tabs to non-private window');
      }
    }

    let groupId = groupOptions.groupId;
    let destinationId = windowId;
    let insertionIndex;
    let before = [];
    let after = ids;
    if (groupId == null) {
      const first = tabs.find(tab => tab.windowId === windowId);
      insertionIndex = first?.index ?? currentWindow.order.length;
      if (first?.groupId !== -1 && first?.groupId != null) {
        const members = memberIds(first.groupId);
        insertionIndex = members[0] === first.id
          ? records.get(members[0]).index
          : records.get(members.at(-1)).index + 1;
      }
      // Translate the old insertion point after removing all selected tabs.
      insertionIndex -= ids.filter(id => {
        const tab = records.get(id);
        return tab.windowId === windowId && tab.index < insertionIndex;
      }).length;
      groupId = nextGroupId++;
    } else {
      const group = groups.get(groupId);
      if (!group || windows.get(group.windowId).incognito !== currentWindow.incognito) {
        throw new Error(`No group with id: ${groupId}`);
      }
      destinationId = group.windowId;
      const firstIndex = records.get(memberIds(groupId)[0]).index;
      before = ids.filter(id => {
        const tab = records.get(id);
        return tab.windowId === windowId && tab.index < firstIndex;
      });
      after = ids.filter(id => !before.includes(id) && records.get(id).groupId !== groupId);
    }

    const previousMembers = memberIds(groupId);
    if (groupOptions.groupId != null) {
      const order = windows.get(destinationId).order;
      const anchor = previousMembers[0] ?? memberIds(groupId)[0];
      insertionIndex = order.slice(0, order.indexOf(anchor)).filter(id => !ids.includes(id)).length;
    }
    detach([...ids, ...previousMembers]);
    const destination = windows.get(destinationId);
    const members = [...before, ...previousMembers, ...after];
    destination.order.splice(insertionIndex, 0, ...members);
    for (const id of members) Object.assign(records.get(id), { groupId, pinned: false, windowId: destinationId });
    groups.set(groupId, { title: '', color: 'blue', collapsed: false, saveOnWindowClose: true, ...groups.get(groupId), id: groupId, windowId: destinationId });
    reindex();
    return groupId;
  }

  function nativeMove(id, moveOptions) {
    const tab = requireTab(id);
    if (moveOptions.windowId != null && moveOptions.windowId !== tab.windowId) {
      throw new Error('Cross-window moves are outside this model');
    }
    const win = windows.get(tab.windowId);
    const oldIndex = tab.index;
    const targetIndex = moveOptions.index === -1
      ? win.order.length - 1
      : Math.min(moveOptions.index, win.order.length - 1);
    const pinnedCount = win.order.filter(tabId => records.get(tabId).pinned).length;
    if (tab.pinned ? targetIndex > pinnedCount : targetIndex < pinnedCount) return snapshotTab(id);
    if (targetIndex === oldIndex) return snapshotTab(id);
    // Firefox moveTabTo inserts after the target while moving forward, before
    // it while moving backward. Its target's native group is inherited.
    const neighbor = records.get(win.order[targetIndex]);
    const targetGroupId = neighbor.groupId;
    win.order.splice(oldIndex, 1);
    win.order.splice(targetIndex, 0, id);
    tab.groupId = targetGroupId;
    reindex();
    return snapshotTab(id);
  }

  const api = {
    tabs: {
      async get(id) {
        await boundary('get', [id]);
        return snapshotTab(id);
      },
      async query(queryInfo) {
        await boundary('query', [queryInfo]);
        return [...records.values()].filter(tab =>
          (queryInfo.windowId == null || tab.windowId === queryInfo.windowId) &&
          (queryInfo.groupId == null || tab.groupId === queryInfo.groupId) &&
          (queryInfo.index == null || tab.index === queryInfo.index)
        ).map(tab => snapshotTab(tab.id));
      },
      async group(groupOptions) {
        await boundary('group', [groupOptions]);
        return nativeGroup(groupOptions);
      },
      async move(id, moveOptions) {
        await boundary('move', [id, moveOptions]);
        return nativeMove(id, moveOptions);
      },
    },
  };

  const model = {
    api,
    calls,
    tab: snapshotTab,
    tabs: () => [...records.keys()].map(snapshotTab).sort((a, b) => a.windowId - b.windowId || a.index - b.index),
    groupIds: () => [...groups.keys()],
    group(id) { return structuredClone(groups.get(id)); },
    setGroupMetadata(id, properties) {
      const group = groups.get(id);
      if (!group) throw new Error(`No group with id: ${id}`);
      Object.assign(group, properties);
    },
    snapshot: () => model.tabs(),
    focus(windowId) { currentWindowId = windowId; },
    close(id) {
      requireTab(id);
      detach([id]);
      records.delete(id);
      reindex();
    },
    patch(id, changes) {
      const tab = requireTab(id);
      if (changes.windowId != null && changes.windowId !== tab.windowId) {
        detach([id]);
        if (!windows.has(changes.windowId)) windows.set(changes.windowId, { incognito: changes.incognito ?? tab.incognito, order: [] });
        windows.get(changes.windowId).order.push(id);
      }
      Object.assign(tab, changes);
      if (tab.groupId !== -1) groups.set(tab.groupId, { title: '', color: 'blue', collapsed: false, saveOnWindowClose: true, ...groups.get(tab.groupId), id: tab.groupId, windowId: tab.windowId });
      reindex();
    },
    failNext(method, error = new Error('Injected API failure')) { faults[method].push(error); },
    holdNext(method, predicate = () => true) {
      const enter = Promise.withResolvers();
      const resume = Promise.withResolvers();
      holds.push({ method, predicate, enter, resume });
      return { entered: enter.promise, release: resume.resolve };
    },
  };
  return model;
}
