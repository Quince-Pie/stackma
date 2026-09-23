/** @typedef {browser.tabs.Tab & {id: number, windowId: number, groupId: number, splitViewId?: number}} Tab */
/** @typedef {{tabId: number, sourceTabId: number, windowId: number}} Relation */
/** @typedef {Relation & {groupId: number, promise: Promise<void>, resolve: (() => void) | undefined}} Job */
/** @typedef {{jobs: Job[], head: number, promise: Promise<void>}} Lane */
/** @typedef {{tabs: Pick<typeof browser.tabs, 'get' | 'query' | 'group' | 'move'>}} API */

const NONE = -1;
const DONE = Promise.resolve();
const validId = (/** @type {unknown} */ id) => typeof id === "number" && Number.isInteger(id) && id >= 0;
const message = (/** @type {unknown} */ error) => error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
const missingTab = (/** @type {unknown} */ error) => /^Invalid tab ID:/.test(message(error));
const privacyMismatch = (/** @type {unknown} */ error) => /^Cannot move (?:non-private|private) tabs to (?:private|non-private) window$/.test(message(error));

class IncompleteJoinError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super("Firefox could not finish joining a related branch", { cause });
  }
}

class UnconfirmedCreationError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super("Firefox did not confirm creation of a new group", { cause });
  }
}

/**
 * Serialize mutations within each window, coalescing consecutive siblings.
 * Firefox owns membership; retained edges only deduplicate events and repair
 * a parent relationship delivered after its descendants. No tab cache or timer.
 * @param {API} api
 * @param {{batchSize?: number, onError?: (error: unknown) => void, onGroupCreated?: (groupId: number, windowId: number, incognito: boolean) => Promise<void>, validateGroupIds?: (ids: Iterable<number>) => Promise<void>}} [options]
 */
export function createStacker(api, { batchSize = 32, onError = console.error, onGroupCreated, validateGroupIds } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new RangeError("batchSize must be an integer from 1 to 256");
  }
  /** @type {Map<number, Job>} */
  const relations = new Map();
  /** @type {Map<number, Set<number>>} */
  const children = new Map();
  /** @type {Map<number, Lane>} */
  const lanes = new Map();
  /** @type {Set<Promise<void>>} */
  const followups = new Set();

  /** @param {unknown} error */
  function report(error) {
    try { onError(error); } catch (reportError) { console.error(reportError); }
  }

  /** @param {number} id @returns {Promise<Tab | undefined>} */
  async function read(id) {
    try {
      return /** @type {Tab} */ (await api.tabs.get(id));
    } catch (error) {
      if (missingTab(error)) return undefined;
      throw error;
    }
  }

  /** @param {Tab | undefined} source @param {Tab | undefined} child @param {number} windowId */
  function eligible(source, child, windowId) {
    return source && child && !source.pinned && !child.pinned &&
      source.windowId === windowId && child.windowId === windowId &&
      source.incognito === child.incognito;
  }

  /** @param {number} id */
  function disown(id) {
    const relation = relations.get(id);
    if (!relation) return;
    relation.groupId = NONE;
    const siblings = children.get(relation.sourceTabId);
    siblings?.delete(id);
    if (!siblings?.size) children.delete(relation.sourceTabId);
  }

  /** @param {number} id @param {number} groupId @param {number} sourceId */
  function remember(id, groupId, sourceId) {
    const relation = relations.get(id);
    if (!relation || relation.groupId === NONE && relation.sourceTabId !== sourceId) return;
    relation.groupId = groupId;
    let descendants = children.get(relation.sourceTabId);
    if (!descendants) children.set(relation.sourceTabId, descendants = new Set());
    descendants.add(id);
  }

  /** Only traverse still-connected, previously assigned descendants. @param {Tab} root */
  async function branch(root) {
    /** @type {Tab[]} */
    const result = [root];
    if (root.groupId === NONE || root.groupId === undefined) return result;
    const visited = new Set([root.id]);
    for (let head = 0; head < result.length; head++) {
      const ids = [...(children.get(/** @type {number} */ (result[head].id)) ?? [])]
        .filter(id => !visited.has(id) && relations.get(id)?.groupId === root.groupId);
      for (let start = 0; start < ids.length; start += batchSize) {
        const chunk = ids.slice(start, start + batchSize);
        chunk.forEach(id => visited.add(id));
        const tabs = await Promise.all(chunk.map(read));
        for (const tab of tabs) {
          if (eligible(root, tab, root.windowId) && tab?.groupId === root.groupId) {
            result.push(tab);
          } else if (tab && relations.get(tab.id)?.groupId !== tab.groupId) {
            disown(tab.id);
          }
        }
      }
    }
    return result;
  }

  /** Prove a complete native group using contiguous indices and its two boundaries.
   * @param {Tab} source @param {Map<number, Tab>} targets @returns {Promise<Tab | undefined>}
   */
  async function reusableGroup(source, targets) {
    /** @type {Map<number, Map<number, Tab>>} */
    const groups = new Map();
    for (const tab of targets.values()) {
      if (tab.groupId < 0) continue;
      let members = groups.get(tab.groupId);
      if (!members) groups.set(tab.groupId, members = new Map());
      members.set(tab.id, tab);
    }
    /** @type {Map<number, Promise<Tab | undefined>>} */
    const neighbors = new Map();
    /** @param {number} index */
    function at(index) {
      if (index < 0) return Promise.resolve(undefined);
      let pending = neighbors.get(index);
      if (!pending) {
        pending = api.tabs.query({ windowId: source.windowId, index })
          .then(tabs => /** @type {Tab | undefined} */ (tabs[0]));
        neighbors.set(index, pending);
      }
      return pending;
    }
    candidate: for (const [groupId, members] of groups) {
      const anchor = /** @type {Tab} */ (members.values().next().value);
      /** @type {Map<number, number>} */
      const splitCounts = new Map();
      for (const tab of members.values()) {
        const splitId = tab.splitViewId ?? NONE;
        if (splitId >= 0) splitCounts.set(splitId, (splitCounts.get(splitId) ?? 0) + 1);
      }
      for (const tab of members.values()) {
        const splitId = tab.splitViewId ?? NONE;
        if (splitId < 0 || splitCounts.get(splitId) === 2) continue;
        const adjacent = await Promise.all([at(tab.index - 1), at(tab.index + 1)]);
        const companion = adjacent.find(other => other?.splitViewId === splitId &&
          other.groupId === groupId && eligible(source, other, source.windowId));
        if (!companion) continue candidate;
        members.set(companion.id, companion);
        splitCounts.set(splitId, 2);
      }
      let first = Infinity, last = -Infinity;
      const indices = new Set();
      for (const tab of members.values()) {
        if (indices.has(tab.index)) continue candidate;
        indices.add(tab.index);
        first = Math.min(first, tab.index);
        last = Math.max(last, tab.index);
      }
      if (last - first + 1 !== members.size) continue;
      const adjacent = await Promise.all([at(first - 1), at(last + 1)]);
      if (adjacent.every(tab => tab?.groupId !== groupId)) return anchor;
    }
    return undefined;
  }

  /** @param {Tab} source @param {Tab} anchor @returns {Promise<Tab | undefined>} */
  async function attachSource(source, anchor) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [parent, member] = await Promise.all([read(source.id), read(anchor.id)]);
        if (!parent || parent.pinned || parent.windowId !== source.windowId) return undefined;
        if (!eligible(parent, member, source.windowId) || member?.groupId !== anchor.groupId) {
          throw new Error("Related group changed before it could be reused");
        }
        if (parent.groupId === anchor.groupId) return parent;
        if (parent.groupId !== NONE) throw new Error("Opener group changed before reuse");
        const moved = await api.tabs.move(parent.id, { index: member.index });
        const result = Array.isArray(moved) ? moved.find(tab => tab.id === parent.id) : moved;
        if (result?.groupId !== anchor.groupId) throw new Error("Firefox did not retain the related group");
        return /** @type {Tab} */ (result);
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    return undefined;
  }

  /** @param {Tab} source @param {Tab} anchor @param {Map<number, Tab>} targets @param {Job[]} jobs */
  async function reuse(source, anchor, targets, jobs) {
    const direct = new Set(jobs.map(job => job.tabId));
    const members = [source.id];
    for (const tab of targets.values()) {
      if (tab.groupId !== anchor.groupId || direct.has(tab.id)) members.push(tab.id);
    }
    try {
      // Validate each incoming relationship, but leave already-grouped
      // descendants alone (including during the private-window fallback).
      await api.tabs.group({ groupId: anchor.groupId, tabIds: members });
      return { groupId: anchor.groupId, ids: members };
    } catch (error) {
      if (!privacyMismatch(error)) throw error;
    }
    // Establish the logical opener's membership before accepting child edges.
    const parent = await attachSource(source, anchor);
    return parent ? join(parent, members.slice(1)) : { groupId: anchor.groupId, ids: [] };
  }

  /**
   * Firefox 156 checks CURRENT window privacy before resolving groupId.
   * In that error case, moving against an actual member joins its native group.
   * No windowId is supplied: move cannot adopt a tab or unpin it.
   * @param {Tab} source @param {number[]} ids
   */
  async function join(source, ids) {
    const groupId = /** @type {number} */ (source.groupId);
    try {
      await api.tabs.group({ groupId, tabIds: ids });
    } catch (error) {
      if (!privacyMismatch(error)) throw error;
      const assigned = [];
      // Keep the complete plan through retries: moving a split-view member can
      // also move its ancestor. Record confirmed progress before the next IPC.
      for (const id of ids.toReversed()) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const [parent, child] = await Promise.all([read(source.id), read(id)]);
            if (!eligible(parent, child, source.windowId)) break;
            if (parent?.groupId !== groupId) throw new Error("Opener group changed during grouping");
            if (child?.groupId !== groupId) {
              const moved = await api.tabs.move(id, { index: /** @type {Tab} */ (parent).index });
              const movedTab = Array.isArray(moved) ? moved.find(tab => tab.id === id) : moved;
              if (movedTab?.groupId !== groupId) throw new Error("Firefox did not place the tab in its opener's group");
            }
            remember(id, groupId, source.id);
            assigned.push(id);
            break;
          } catch (moveError) {
            if (attempt === 1) throw new IncompleteJoinError(moveError);
          }
        }
      }
      return { groupId, ids: assigned };
    }
    return { groupId, ids };
  }

  /** @param {Job[]} jobs */
  async function apply(jobs) {
    const first = jobs[0];
    const [source, ...tabs] = await Promise.all([
      read(first.sourceTabId), ...jobs.map(job => read(job.tabId)),
    ]);
    if (!source || source.windowId !== first.windowId) return;
    const previous = relations.get(source.id);
    if (previous && previous.groupId !== NONE && previous.groupId !== source.groupId) disown(source.id);
    if (source.pinned) return;
    if (validateGroupIds) {
      const ids = new Set();
      for (const child of tabs) {
        if (!child || !eligible(source, child, first.windowId)) continue;
        if (source.groupId >= 0) ids.add(source.groupId);
        if (child.groupId >= 0) ids.add(child.groupId);
      }
      // Read endpoints before this barrier: Firefox delivers earlier native
      // group lifecycle events before the corresponding API reply settles.
      if (ids.size) await validateGroupIds(ids);
    }
    /** @type {Map<number, Tab>} */
    const targets = new Map();
    let hasGroupedChild = false;
    for (const child of tabs) {
      if (!eligible(source, child, first.windowId) || !child) continue;
      if (source.groupId !== NONE && source.groupId !== undefined && child.groupId === source.groupId) {
        remember(child.id, source.groupId, source.id);
        continue;
      }
      hasGroupedChild ||= child.groupId >= 0;
      for (const tab of await branch(child)) targets.set(/** @type {number} */ (tab.id), tab);
    }
    targets.delete(/** @type {number} */ (source.id));
    if (!targets.size) return;
    const ids = [...targets.keys()];
    let result;
    let created = false;
    if (source.groupId !== NONE && source.groupId !== undefined) {
      result = await join(source, ids);
    } else {
      const anchor = hasGroupedChild ? await reusableGroup(source, targets) : undefined;
      if (anchor) {
        result = await reuse(source, anchor, targets, jobs);
      } else {
        let groupId;
        try {
          groupId = await api.tabs.group({ tabIds: [source.id, ...ids], createProperties: { windowId: source.windowId } });
        } catch (error) {
          if (onGroupCreated) throw new UnconfirmedCreationError(error);
          throw error;
        }
        result = { groupId, ids: [source.id, ...ids] };
      }
      created = !anchor;
    }
    for (const id of result.ids) remember(id, result.groupId, source.id);
    if (created) return { groupId: result.groupId, windowId: source.windowId, incognito: source.incognito };
  }

  /** @param {number} windowId @param {Lane} lane */
  async function drain(windowId, lane) {
    try {
      while (lane.head < lane.jobs.length) {
        const start = lane.head++;
        const source = lane.jobs[start].sourceTabId;
        while (lane.head < lane.jobs.length && lane.head - start < batchSize &&
          lane.jobs[lane.head].sourceTabId === source) lane.head++;
        const batch = lane.jobs.slice(start, lane.head);
        let created;
        try {
          try {
            created = await apply(batch);
          } catch (error) {
            if (error instanceof IncompleteJoinError) throw error;
            // Re-read once: an endpoint may have closed or changed group during IPC.
            created = await apply(batch);
            if (error instanceof UnconfirmedCreationError && !created) {
              const opener = await read(batch[0].sourceTabId);
              if (opener?.windowId === windowId && opener.groupId >= 0) {
                // Membership can recover without proving who created a group.
                // Keep its title authoritative and report the naming omission.
                report(error);
              }
            }
          }
        } catch (error) {
          report(error);
        }
        const finish = () => {
          for (const job of batch) {
            job.resolve?.();
            job.resolve = undefined;
            job.promise = DONE;
          }
        };
        if (created && onGroupCreated) {
          // Naming is downstream of committed membership, outside its retry.
          // Keep the event promise alive without blocking this window's FIFO.
          let completion;
          try {
            completion = Promise.resolve(onGroupCreated(created.groupId, created.windowId, created.incognito));
          } catch (error) {
            completion = Promise.reject(error);
          }
          const settled = completion.catch(report).then(finish).finally(() => followups.delete(settled));
          followups.add(settled);
        } else {
          finish();
        }
        if (lane.head >= 1024 && lane.head * 2 >= lane.jobs.length) {
          lane.jobs.splice(0, lane.head);
          lane.head = 0;
        }
      }
    } finally {
      lanes.delete(windowId);
    }
  }

  /** @param {Relation} relation @returns {Promise<void>} */
  function enqueue(relation) {
    const { tabId, sourceTabId, windowId } = relation;
    if (![tabId, sourceTabId, windowId].every(validId) || tabId === sourceTabId) return DONE;
    const existing = relations.get(tabId);
    if (existing) return existing.promise;
    const { promise, resolve } = Promise.withResolvers();
    const job = { ...relation, promise, resolve: () => resolve(undefined), groupId: NONE };
    relations.set(tabId, job);
    let lane = lanes.get(windowId);
    if (!lane) {
      lane = { jobs: [], head: 0, promise: Promise.resolve() };
      lanes.set(windowId, lane);
      const next = lane;
      next.promise = Promise.resolve().then(() => drain(windowId, next));
    }
    lane.jobs.push(job);
    return promise;
  }

  /** @param {number} tabId */
  function forget(tabId) {
    const relation = relations.get(tabId);
    if (relation) {
      const siblings = children.get(relation.sourceTabId);
      siblings?.delete(tabId);
      if (!siblings?.size) children.delete(relation.sourceTabId);
    }
    relations.delete(tabId);
    children.delete(tabId);
  }

  return {
    enqueue,
    forget,
    async idle() {
      while (lanes.size || followups.size) {
        await Promise.all([...lanes.values()].map(lane => lane.promise).concat([...followups]));
      }
    },
    diagnostics: () => ({
      relations: relations.size,
      windows: lanes.size,
      pending: [...lanes.values()].reduce((count, lane) => count + lane.jobs.length - lane.head, 0),
    }),
  };
}
