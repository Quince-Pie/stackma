// Experimental transient-context challenger; not the production namer.
import { chooseName } from "../extension/name-generator.js";

/** @typedef {{name: string, windowId: number}} Entry */
/** @typedef {{id: number, windowId: number, privacy: number, cancelled: boolean, assigned: boolean, alias?: string, promise: Promise<void>}} Pending */
/** @typedef {{epoch: object, windowIds: Set<number | undefined>, groups: {id: number, windowId: number, title: string}[], ambiguous: Set<number>}} Context */
/** @typedef {{tail: Promise<void>, queued: number, epoch: object, context?: Context}} Lane */
/** @typedef {{tabGroups: Pick<typeof browser.tabGroups, 'get' | 'query' | 'update'>, windows: Pick<typeof browser.windows, 'getAll'>, storage: {session: Pick<typeof browser.storage.session, 'get' | 'set' | 'remove'>}}} API */

const RECENT = 64;
const DONE = Promise.resolve();
const message = (/** @type {unknown} */ error) => error && typeof error === "object" && "message" in error ? String(error.message) : "";
const missingGroup = (/** @type {unknown} */ error) => /^No group with id:/.test(message(error));

/**
 * One-shot authority: callers may enqueue ONLY the result of a new native group
 * creation. Native labels become authoritative after this attempt, including
 * manual clearing. No ownership or group-ID mapping survives the attempt.
 *
 * A lane serializes query/allocate/reserve/commit within each privacy class.
 * Context is reused only during a nonempty lane, invalidated by external native
 * events, and released when the lane drains. Fresh per-job target reads and
 * session-history reads/writes remain. Integration MUST register created and
 * windowCreated as well as the production callbacks, synchronously at startup.
 *
 * Each job's initial fresh group read is an event-delivery barrier on the active,
 * synchronously registered Firefox 156 event page. Mutations after that read
 * remain within the platform's ordinary non-atomic read/commit boundary.
 * External writers remain outside this lane; Firefox has no conditional title
 * update. Only {title} is written, so other native metadata stays untouched.
 * @param {API} api
 * @param {{onError?: (error: unknown) => void, choose?: typeof chooseName}} [options]
 */
export function createNamer(api, { onError = console.error, choose = chooseName } = {}) {
  /** @type {Lane[]} */
  const lanes = [
    { tail: DONE, queued: 0, epoch: {} },
    { tail: DONE, queued: 0, epoch: {} },
  ];
  /** @type {Map<number, Pending>} */
  const pending = new Map();

  /** @param {unknown} error */
  function report(error) {
    try { onError(error); } catch (reportError) { console.error(reportError); }
  }

  /** @param {boolean} incognito @param {() => Promise<void>} task */
  function queue(incognito, task) {
    const lane = lanes[Number(incognito)];
    lane.queued++;
    const result = lane.tail.then(task).catch(report).finally(() => {
      if (--lane.queued === 0) lane.context = undefined;
    });
    lane.tail = result;
    return result;
  }

  function invalidate() {
    for (const lane of lanes) {
      if (!lane.queued) continue;
      // Object identity is an epoch without integer wraparound or a history.
      lane.epoch = {};
      lane.context = undefined;
    }
  }

  /** @param {boolean} incognito @param {number} windowId @returns {Promise<Context>} */
  async function context(incognito, windowId) {
    const lane = lanes[Number(incognito)];
    if (lane.context?.epoch === lane.epoch && lane.context.windowIds.has(windowId)) return lane.context;
    const epoch = lane.epoch;
    const [windows, groups] = await Promise.all([api.windows.getAll(), api.tabGroups.query({})]);
    const windowIds = new Set(windows.filter(win => win.incognito === incognito).map(win => win.id));
    const seen = new Set();
    const ambiguous = new Set();
    for (const { id } of groups) {
      if (seen.has(id)) ambiguous.add(id);
      else seen.add(id);
    }
    const snapshot = {
      epoch, windowIds, ambiguous,
      // Preserve every title: two native objects can share an ID, even when
      // this operation names a completely different, uniquely identified group.
      groups: groups.filter(group => windowIds.has(group.windowId)).map(group =>
        ({ id: group.id, windowId: group.windowId, title: group.title ?? "" })),
    };
    // An invalidated query may serve its current operation, matching the fresh
    // reader's read/commit boundary, but is never reused by a later operation.
    if (lane.epoch === epoch) lane.context = snapshot;
    return snapshot;
  }

  /** @param {Pending} job @param {browser.tabGroups.TabGroup} group */
  function observed(job, group) {
    const lane = lanes[job.privacy];
    if (group.windowId !== job.windowId) { invalidate(); return; }
    if (lane.context?.epoch === lane.epoch) {
      if (lane.context.ambiguous.has(group.id)) { invalidate(); return; }
      const entry = lane.context.groups.find(entry => entry.id === group.id);
      if (!entry) { invalidate(); return; }
      entry.windowId = group.windowId;
      entry.title = group.title ?? "";
    }
  }

  /** @param {string} key @returns {Promise<Entry[]>} */
  async function history(key) {
    const data = (await api.storage.session.get(key))[key];
    if (!Array.isArray(data)) return [];
    return data.filter((/** @type {unknown} */ entry) => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || !("windowId" in entry)) return false;
      return typeof entry.name === "string" && /^(?:[a-z]+-[a-z]+|stack-[1-9][0-9]*)$/.test(entry.name) &&
        typeof entry.windowId === "number" && Number.isSafeInteger(entry.windowId) && entry.windowId >= 0;
    }).slice(-RECENT);
  }

  /** @param {Pending} job */
  async function read(job) {
    if (job.cancelled) return undefined;
    try {
      const group = await api.tabGroups.get(job.id);
      observed(job, group);
      if (job.cancelled || group.windowId !== job.windowId) return undefined;
      return group;
    } catch (error) {
      if (missingGroup(error)) { invalidate(); return undefined; }
      throw error;
    }
  }

  /** @param {Pending} job @param {boolean} incognito */
  async function assign(job, incognito) {
    const initial = await read(job);
    if (!initial || initial.title) return;
    const key = incognito ? "naming.private" : "naming.normal";
    const [snapshot, previous] = await Promise.all([context(incognito, job.windowId), history(key)]);
    if (job.cancelled) return;
    if (snapshot.ambiguous.has(job.id)) {
      throw new Error("Firefox returned an ambiguous group ID; its name was left unchanged");
    }
    const { windowIds, groups } = snapshot;
    if (!windowIds.has(job.windowId)) return;
    const recent = incognito ? previous.filter(entry => windowIds.has(entry.windowId)) : previous;
    const titles = [];
    for (const group of groups) if (group.id !== job.id) titles.push(group.title);
    titles.push(...recent.map(entry => entry.name));
    const selected = choose(titles);
    job.alias = selected.name;
    // The privacy lane is the reservation lock, across all windows. Persist
    // before title IPC so a suspended event page retains recent assignments.
    // A failed/cancelled assignment may conservatively consume a recent slot.
    await api.storage.session.set({
      [key]: [...recent, { name: selected.name, windowId: job.windowId }].slice(-RECENT),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const group = await read(job);
      if (!group || group.title === job.alias || group.title) return;
      try {
        // No CAS exists: an unseen external edit after this read can still race.
        const committed = await api.tabGroups.update(job.id, { title: job.alias });
        // Publish only a confirmed native result, never the reservation itself.
        if (!job.cancelled) observed(job, committed);
        return;
      } catch (error) {
        if (missingGroup(error)) return;
        // A native event already proved this one-shot assignment committed.
        // In particular, never restore it over a subsequent manual clearing.
        if (job.assigned) return;
        if (attempt === 1) throw error;
        // A rejected IPC may have committed. The next read prevents a rewrite
        // of an already assigned or manually changed title.
      }
    }
  }

  /** @param {number} groupId @param {number} windowId @param {boolean} incognito */
  function enqueue(groupId, windowId, incognito) {
    const existing = pending.get(groupId);
    if (existing) return existing.promise;
    /** @type {Pending} */
    const job = { id: groupId, windowId, privacy: Number(incognito), cancelled: false, assigned: false, promise: DONE };
    pending.set(groupId, job);
    job.promise = queue(incognito, () => assign(job, incognito)).finally(() => pending.delete(groupId));
    return job.promise;
  }

  /** @param {browser.tabGroups.TabGroup} group */
  function updated(group) {
    const job = pending.get(group.id);
    // Empty-title color/collapse updates are not renames. Once a nonempty
    // external title was observed, later clearing does not restore authority.
    if (job?.alias && group.title === job.alias && group.windowId === job.windowId) {
      job.assigned = true;
      observed(job, group);
      return;
    }
    if (job && (group.title || job.assigned)) job.cancelled = true;
    invalidate();
  }

  /** @param {browser.tabGroups.TabGroup} group */
  function removed(group) {
    const job = pending.get(group.id);
    if (job) job.cancelled = true;
    invalidate();
  }

  /** @param {browser.tabGroups.TabGroup} group */
  function moved(group) {
    const job = pending.get(group.id);
    if (job && group.windowId !== job.windowId) job.cancelled = true;
    invalidate();
  }

  /** @param {browser.tabGroups.TabGroup} group */
  function created(group) {
    // Even an unnamed group can collide with a pending native ID. Firefox
    // dispatches the first creation before resolving the stacker's tabs.group.
    const job = pending.get(group.id);
    if (job && !job.cancelled) {
      job.cancelled = true;
      report(new Error("Firefox reused a pending group ID; its name was left unchanged"));
    }
    invalidate();
  }

  /** @param {browser.windows.Window} _window */
  function windowCreated(_window) { invalidate(); }

  /** @param {number} windowId */
  function closedWindow(windowId) {
    for (const job of pending.values()) if (job.windowId === windowId) job.cancelled = true;
    invalidate();
    // Same lane as private assignment: a late storage.set cannot resurrect
    // history belonging to a closed private window.
    return queue(true, async () => {
      const key = "naming.private";
      const previous = await history(key);
      const remaining = previous.filter(entry => entry.windowId !== windowId);
      if (remaining.length === previous.length) return;
      if (remaining.length) await api.storage.session.set({ [key]: remaining });
      else await api.storage.session.remove(key);
    });
  }

  return {
    enqueue, updated, removed, moved, created, windowCreated, closedWindow,
    diagnostics() {
      return {
        queued: lanes.reduce((sum, lane) => sum + lane.queued, 0),
        contexts: lanes.filter(lane => lane.context).length,
        cachedGroups: lanes.reduce((sum, lane) => sum + (lane.context?.groups.length ?? 0), 0),
      };
    },
    async idle() {
      // Jobs can enqueue while an earlier snapshot is settling.
      for (;;) {
        const snapshot = lanes.map(lane => lane.tail);
        await Promise.all(snapshot);
        if (snapshot.every((tail, index) => tail === lanes[index].tail)) return;
      }
    },
  };
}
