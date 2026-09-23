import { chooseName } from "./name-generator.js";

/** @typedef {{name: string, windowId: number}} Entry */
/** @typedef {{id: number, windowId: number, cancelled: boolean, assigned: boolean, alias?: string, promise: Promise<void>}} Pending */
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
 * External writers remain outside this lane; Firefox has no conditional title
 * update. Only {title} is written, so other native metadata stays untouched.
 * @param {API} api
 * @param {{onError?: (error: unknown) => void, choose?: typeof chooseName}} [options]
 */
export function createNamer(api, { onError = console.error, choose = chooseName } = {}) {
  const lanes = [DONE, DONE];
  /** @type {Map<number, Pending>} */
  const pending = new Map();

  /** @param {unknown} error */
  function report(error) {
    try { onError(error); } catch (reportError) { console.error(reportError); }
  }

  /** @param {boolean} incognito @param {() => Promise<void>} task */
  function queue(incognito, task) {
    const index = Number(incognito);
    const result = lanes[index].then(task).catch(report);
    lanes[index] = result;
    return result;
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
      if (job.cancelled || group.windowId !== job.windowId) return undefined;
      return group;
    } catch (error) {
      if (missingGroup(error)) return undefined;
      throw error;
    }
  }

  /** @param {Pending} job @param {boolean} incognito */
  async function assign(job, incognito) {
    const initial = await read(job);
    if (!initial || initial.title) return;
    const key = incognito ? "naming.private" : "naming.normal";
    // Two native snapshots rather than a permanent group cache. Both privacy
    // classes are visible to a spanning extension; only matching titles enter
    // selection and only generated aliases enter storage.
    const [windows, groups, previous] = await Promise.all([
      api.windows.getAll(), api.tabGroups.query({}), history(key),
    ]);
    if (job.cancelled) return;
    // Firefox 156's native timestamp/random ID generator can collide (1960104).
    // The public update API cannot distinguish those objects. Do not give the
    // new group's naming authority to an existing group with the same ID.
    let found = false;
    for (const group of groups) {
      if (group.id !== job.id) continue;
      if (found) throw new Error("Firefox returned an ambiguous group ID; its name was left unchanged");
      found = true;
    }
    const windowIds = new Set(windows.filter(win => win.incognito === incognito).map(win => win.id));
    if (!windowIds.has(job.windowId)) return;
    const recent = incognito ? previous.filter(entry => windowIds.has(entry.windowId)) : previous;
    const titles = groups.filter(group => windowIds.has(group.windowId) && group.id !== job.id)
      .map(group => group.title ?? "");
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
        await api.tabGroups.update(job.id, { title: job.alias });
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
    const job = { id: groupId, windowId, cancelled: false, assigned: false, promise: DONE };
    pending.set(groupId, job);
    job.promise = queue(incognito, () => assign(job, incognito)).finally(() => pending.delete(groupId));
    return job.promise;
  }

  /** @param {browser.tabGroups.TabGroup} group */
  function updated(group) {
    const job = pending.get(group.id);
    // Empty-title color/collapse updates are not renames. Once a nonempty
    // external title was observed, later clearing does not restore authority.
    if (!job) return;
    if (job.alias && group.title === job.alias) job.assigned = true;
    else if (group.title || job.assigned) job.cancelled = true;
  }

  /** @param {browser.tabGroups.TabGroup} group */
  function removed(group) {
    const job = pending.get(group.id);
    if (job) job.cancelled = true;
  }

  /** @param {browser.tabGroups.TabGroup} group */
  function moved(group) {
    const job = pending.get(group.id);
    if (job && group.windowId !== job.windowId) job.cancelled = true;
  }

  /** A different creation with the same ID invalidates pending authority.
   * Firefox dispatches its own create event before resolving tabs.group, hence
   * before the stacker grants the first naming attempt. @param {browser.tabGroups.TabGroup} group
   */
  function created(group) {
    const job = pending.get(group.id);
    if (job && !job.cancelled) {
      job.cancelled = true;
      report(new Error("Firefox reused a pending group ID; its name was left unchanged"));
    }
  }

  /** @param {number} windowId */
  function closedWindow(windowId) {
    for (const job of pending.values()) if (job.windowId === windowId) job.cancelled = true;
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
    enqueue, updated, removed, moved, created, closedWindow,
    async idle() {
      // Jobs can enqueue while an earlier snapshot is settling.
      for (;;) {
        const snapshot = [...lanes];
        await Promise.all(snapshot);
        if (snapshot.every((lane, index) => lane === lanes[index])) return;
      }
    },
  };
}
