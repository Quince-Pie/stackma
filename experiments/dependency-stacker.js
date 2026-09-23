// Experimental dependency scheduler. Not shipped in the extension.
// Fresh eligibility, lineage repair, and failure policy match stacker.js.
// Ordinary disjoint components overlap. A writer-preferring window gate makes
// split-view work, metadata-preserving reuse, and index-based privacy recovery
// exclusive with all mutations.
//
// Argument, assuming the same native-operation contract as the shipped kernel:
// - Admission unions source/child identity and waits both earlier component tails.
//   Accepted descendants therefore share a tail even after their window changes.
// - A coalesced batch has one source; unresolved dependencies may be added only
//   before its dependency wait starts. Fresh children may join until sealing.
// - Disjoint ordinary batches touch disjoint tab IDs. Sharing a native group does
//   not invalidate its ID while another batch's source remains a member. Native
//   group operations compute positions at execution, rather than using indices.
// - A split participant can implicitly move an unrelated companion, so that
//   plan is rebuilt under an exclusive window permit. Group reuse also requires
//   that permit: its indexed exclusivity proof cannot overlap other components'
//   tab movements. Index recovery uses the same permit. Escalation releases the
//   reader permit before waiting and rereads the entire plan.
// - Completed fallback members are remembered immediately; an unrecoverable
//   partial result is reported without restarting through the satisfied root.
// Public-API read/mutation races with external actors remain the shipped policy.
//
// Cost/tradeoff: at most two endpoint descriptors and Set memberships per live
// recorded relation, plus active work. Each union relabels the smaller current
// member set. Ordinary burst API counts match bounded sibling batching, but
// simultaneous independent components can have O(component count) outstanding
// API operations. Split/privacy escalation rereads the plan. Historical unions
// deliberately remain connected until members close: moving branches apart can
// retain serialization across windows. These costs must accompany latency data.
const NONE = -1;
const DONE = Promise.resolve();
const validId = id => typeof id === 'number' && Number.isInteger(id) && id >= 0;
const message = error => error && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
const missingTab = error => /^Invalid tab ID:/.test(message(error));
const privacyMismatch = error => /^Cannot move (?:non-private|private) tabs to (?:private|non-private) window$/.test(message(error));
const split = tab => typeof tab?.splitViewId === 'number' && tab.splitViewId >= 0;

class ExclusiveRequired extends Error {
  constructor(privacy = false) { super('An exclusive window operation is required'); this.privacy = privacy; }
}
class IncompleteJoinError extends Error {
  constructor(cause) { super('Firefox could not finish joining a related branch', { cause }); }
}

export function createStacker(api, { batchSize = 32, onError = console.error } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new RangeError('batchSize must be an integer from 1 to 256');
  const relations = new Map();
  const children = new Map();
  // Stable tab IDs carry dependencies across window moves. A per-window index
  // would let a moved descendant start a second independent component while an
  // earlier ancestor merge still owns its accepted lineage.
  const endpoints = new Map(); // tabId -> {component, references}
  const active = new Set();
  const gates = new Map();

  async function read(id) {
    try { return await api.tabs.get(id); }
    catch (error) { if (missingTab(error)) return undefined; throw error; }
  }
  function eligible(source, child, windowId) {
    return source && child && !source.pinned && !child.pinned &&
      source.windowId === windowId && child.windowId === windowId && source.incognito === child.incognito;
  }
  function disown(id) {
    const relation = relations.get(id);
    if (!relation) return;
    relation.groupId = NONE;
    const siblings = children.get(relation.sourceTabId);
    siblings?.delete(id);
    if (!siblings?.size) children.delete(relation.sourceTabId);
  }
  function remember(id, groupId, sourceId) {
    const relation = relations.get(id);
    if (!relation || relation.groupId === NONE && relation.sourceTabId !== sourceId) return;
    relation.groupId = groupId;
    let descendants = children.get(relation.sourceTabId);
    if (!descendants) children.set(relation.sourceTabId, descendants = new Set());
    descendants.add(id);
  }
  async function branch(root) {
    const result = [root];
    if (root.groupId === NONE || root.groupId === undefined) return result;
    const visited = new Set([root.id]);
    for (let head = 0; head < result.length; head++) {
      const ids = [...(children.get(result[head].id) ?? [])]
        .filter(id => !visited.has(id) && relations.get(id)?.groupId === root.groupId);
      for (let start = 0; start < ids.length; start += batchSize) {
        const chunk = ids.slice(start, start + batchSize);
        chunk.forEach(id => visited.add(id));
        for (const tab of await Promise.all(chunk.map(read))) {
          if (eligible(root, tab, root.windowId) && tab.groupId === root.groupId) result.push(tab);
          else if (tab && relations.get(tab.id)?.groupId !== tab.groupId) disown(tab.id);
        }
      }
    }
    return result;
  }

  // Called only while holding the exclusive window permit. The same proof as
  // the delivered kernel preserves metadata without reading or copying it.
  async function reusableGroup(source, targets) {
    const groups = new Map();
    for (const tab of targets.values()) {
      if (tab.groupId < 0) continue;
      let members = groups.get(tab.groupId);
      if (!members) groups.set(tab.groupId, members = new Map());
      members.set(tab.id, tab);
    }
    const neighbors = new Map();
    function at(index) {
      if (index < 0) return Promise.resolve(undefined);
      let pending = neighbors.get(index);
      if (!pending) {
        pending = api.tabs.query({ windowId: source.windowId, index }).then(tabs => tabs[0]);
        neighbors.set(index, pending);
      }
      return pending;
    }
    candidate: for (const [groupId, members] of groups) {
      const anchor = members.values().next().value;
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

  async function attachSource(source, anchor) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [parent, member] = await Promise.all([read(source.id), read(anchor.id)]);
        if (!parent || parent.pinned || parent.windowId !== source.windowId) return undefined;
        if (!eligible(parent, member, source.windowId) || member?.groupId !== anchor.groupId) {
          throw new Error('Related group changed before it could be reused');
        }
        if (parent.groupId === anchor.groupId) return parent;
        if (parent.groupId !== NONE) throw new Error('Opener group changed before reuse');
        const moved = await api.tabs.move(parent.id, { index: member.index });
        const result = Array.isArray(moved) ? moved.find(tab => tab.id === parent.id) : moved;
        if (result?.groupId !== anchor.groupId) throw new Error('Firefox did not retain the related group');
        return result;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    return undefined;
  }

  async function reuse(source, anchor, targets, jobs) {
    const direct = new Set(jobs.map(job => job.tabId));
    const members = [source.id];
    for (const tab of targets.values()) {
      if (tab.groupId !== anchor.groupId || direct.has(tab.id)) members.push(tab.id);
    }
    try {
      await api.tabs.group({ groupId: anchor.groupId, tabIds: members });
      return { groupId: anchor.groupId, ids: members };
    } catch (error) {
      if (!privacyMismatch(error)) throw error;
    }
    const parent = await attachSource(source, anchor);
    return parent ? join(parent, members.slice(1), true, false) : { groupId: anchor.groupId, ids: [] };
  }

  // Window gate: existing readers may finish; once a writer queues, new readers
  // queue behind it. Release precedes escalation, avoiding upgrade deadlock.
  function acquire(windowId, exclusive) {
    let gate = gates.get(windowId);
    if (!gate) gates.set(windowId, gate = { readers: 0, writer: false, queue: [] });
    const { promise, resolve } = Promise.withResolvers();
    gate.queue.push({ exclusive, resolve });
    pump();
    return promise;

    function pump() {
      if (gate.writer) return;
      while (gate.queue.length) {
        const first = gate.queue[0];
        if (first.exclusive && gate.readers) return;
        gate.queue.shift();
        if (first.exclusive) gate.writer = true;
        else gate.readers++;
        let released = false;
        first.resolve(() => {
          if (released) return;
          released = true;
          if (first.exclusive) gate.writer = false;
          else gate.readers--;
          pump();
          if (!gate.writer && !gate.readers && !gate.queue.length) gates.delete(windowId);
        });
        if (first.exclusive) return;
      }
    }
  }

  async function join(source, ids, exclusive, useMoves) {
    const groupId = source.groupId;
    if (!useMoves) {
      try {
        await api.tabs.group({ groupId, tabIds: ids });
        return { groupId, ids };
      } catch (error) {
        if (!privacyMismatch(error)) throw error;
        if (!exclusive) throw new ExclusiveRequired(true);
      }
    }
    const assigned = [];
    for (const id of ids.toReversed()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const [parent, child] = await Promise.all([read(source.id), read(id)]);
          if (!eligible(parent, child, source.windowId)) break;
          if (parent.groupId !== groupId) throw new Error('Opener group changed during grouping');
          if (child.groupId !== groupId) {
            const moved = await api.tabs.move(id, { index: parent.index });
            const movedTab = Array.isArray(moved) ? moved.find(tab => tab.id === id) : moved;
            if (movedTab?.groupId !== groupId) throw new Error("Firefox did not place the tab in its opener's group");
          }
          remember(id, groupId, source.id);
          assigned.push(id);
          break;
        } catch (error) {
          if (attempt === 1) throw new IncompleteJoinError(error);
        }
      }
    }
    return { groupId, ids: assigned };
  }

  async function apply(jobs, exclusive, useMoves) {
    const first = jobs[0];
    const [source, ...tabs] = await Promise.all([read(first.sourceTabId), ...jobs.map(job => read(job.tabId))]);
    if (!source || source.windowId !== first.windowId) return;
    const previous = relations.get(source.id);
    if (previous && previous.groupId !== NONE && previous.groupId !== source.groupId) disown(source.id);
    if (source.pinned) return;
    const targets = new Map();
    let hasSplitParticipant = split(source);
    let hasGroupedChild = false;
    for (const child of tabs) {
      if (!eligible(source, child, first.windowId)) continue;
      hasSplitParticipant ||= split(child);
      if (source.groupId !== NONE && source.groupId !== undefined && child.groupId === source.groupId) {
        remember(child.id, source.groupId, source.id);
        continue;
      }
      hasGroupedChild ||= child.groupId >= 0;
      for (const tab of await branch(child)) {
        targets.set(tab.id, tab);
        hasSplitParticipant ||= split(tab);
      }
    }
    targets.delete(source.id);
    if (!targets.size) return;
    const sourceGrouped = source.groupId !== NONE && source.groupId !== undefined;
    if ((hasSplitParticipant || !sourceGrouped && hasGroupedChild) && !exclusive) throw new ExclusiveRequired();
    const ids = [...targets.keys()];
    let result;
    if (sourceGrouped) {
      result = await join(source, ids, exclusive, useMoves);
    } else {
      const anchor = hasGroupedChild ? await reusableGroup(source, targets) : undefined;
      result = anchor ? await reuse(source, anchor, targets, jobs) : {
        groupId: await api.tabs.group({ tabIds: [source.id, ...ids], createProperties: { windowId: source.windowId } }),
        ids: [source.id, ...ids],
      };
    }
    for (const id of result.ids) remember(id, result.groupId, source.id);
  }

  async function execute(batch) {
    let exclusive = false;
    let useMoves = false;
    for (;;) {
      const release = await acquire(batch.windowId, exclusive);
      try {
        try { await apply(batch.jobs, exclusive, useMoves); }
        catch (error) {
          if (error instanceof ExclusiveRequired || error instanceof IncompleteJoinError) throw error;
          await apply(batch.jobs, exclusive, useMoves);
        }
        return;
      } catch (error) {
        if (error instanceof ExclusiveRequired && !exclusive) {
          exclusive = true;
          useMoves = error.privacy;
          continue;
        }
        try { onError(error); } catch (reportError) { console.error(reportError); }
        return;
      } finally { release(); }
    }
  }

  function endpoint(id) {
    let entry = endpoints.get(id);
    if (!entry) {
      const component = { members: new Set([id]), tail: null, lastBatch: null };
      endpoints.set(id, entry = { component, references: 0 });
    }
    entry.references++;
    return entry.component;
  }

  function merge(a, b) {
    if (a === b) return a;
    if (a.members.size < b.members.size) [a, b] = [b, a];
    for (const id of b.members) {
      endpoints.get(id).component = a;
      a.members.add(id);
    }
    b.members.clear();
    return a;
  }

  function enqueue(relation) {
    const { tabId, sourceTabId, windowId } = relation;
    if (![tabId, sourceTabId, windowId].every(validId) || tabId === sourceTabId) return DONE;
    const existing = relations.get(tabId);
    if (existing) return existing.promise;
    const deferred = Promise.withResolvers();
    const job = { ...relation, promise: deferred.promise, resolve: () => deferred.resolve(), groupId: NONE };
    relations.set(tabId, job);
    const source = endpoint(sourceTabId);
    const child = endpoint(tabId);
    const priorTails = new Set();
    for (const component of [source, child]) {
      if (component.lastBatch && !component.lastBatch.complete) priorTails.add(component.tail);
    }
    let batch = source.lastBatch;
    // A dependency-waiting batch can still admit fresh/completed child
    // components. Adding an unresolved new dependency after Promise.all took
    // its snapshot would be unsafe, so that case starts a new batch instead.
    const childComplete = child === source || !child.lastBatch || child.lastBatch.complete;
    const append = batch && !batch.sealed && (!batch.waiting || childComplete) &&
      batch.sourceTabId === sourceTabId && batch.jobs.length < batchSize;
    const component = merge(source, child);
    if (append) {
      batch.jobs.push(job);
      for (const tail of priorTails) if (tail !== batch.promise) batch.dependencies.add(tail);
    } else {
      const completion = Promise.withResolvers();
      batch = {
        jobs: [job], sourceTabId, windowId, dependencies: priorTails,
        sealed: false, waiting: false, complete: false, promise: completion.promise,
      };
      active.add(batch);
      const current = batch;
      void Promise.resolve().then(async () => {
        current.waiting = true;
        try {
          await Promise.all(current.dependencies);
          current.sealed = true;
          await execute(current);
        } catch (error) {
          try { onError(error); } catch (reportError) { console.error(reportError); }
        } finally {
          current.complete = true;
          active.delete(current);
          for (const item of current.jobs) {
            item.resolve();
            item.resolve = undefined;
            item.promise = DONE;
          }
          completion.resolve();
        }
      });
    }
    component.tail = batch.promise;
    component.lastBatch = batch;
    return job.promise;
  }

  function dropReference(id) {
    const entry = endpoints.get(id);
    if (!entry || --entry.references > 0) return;
    entry.component.members.delete(id);
    endpoints.delete(id);
  }
  function forget(tabId) {
    const relation = relations.get(tabId);
    if (relation) {
      const siblings = children.get(relation.sourceTabId);
      siblings?.delete(tabId);
      if (!siblings?.size) children.delete(relation.sourceTabId);
      dropReference(tabId);
      dropReference(relation.sourceTabId);
    }
    relations.delete(tabId);
    children.delete(tabId);
    const entry = endpoints.get(tabId);
    if (entry) {
      entry.component.members.delete(tabId);
      endpoints.delete(tabId);
    }
  }
  return {
    enqueue, forget,
    async idle() { while (active.size) await Promise.all([...active].map(batch => batch.promise)); },
    diagnostics: () => ({
      relations: relations.size,
      windows: new Set([...active].map(batch => batch.windowId)).size,
      pending: [...active].reduce((count, batch) => count + batch.jobs.length, 0),
    }),
  };
}
