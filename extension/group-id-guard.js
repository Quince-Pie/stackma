/** @typedef {{tabGroups: Pick<typeof browser.tabGroups, 'query'>}} API */
/** @typedef {{epoch: object, promise: Promise<Set<number>>}} Validation */

/**
 * Firefox can assign the same native ID to distinct groups. Retain only IDs
 * observed to be ambiguous, never group titles, membership, or full snapshots.
 *
 * Integrators must invalidate on native group creation/removal/moves and window
 * changes. Call validate after a fresh native tab read: that reply is the event
 * delivery barrier for changes preceding the read in the active Firefox page.
 * Later changes remain within the platform's non-atomic check/commit boundary.
 *
 * Each validate uses a current cache or one fresh native snapshot. Validators
 * starting in one epoch share their in-flight snapshot; invalidation prevents
 * subsequent validators from joining or publishing an older snapshot. No retry
 * loop or initialization IPC is needed. A failed query rejects to its caller.
 * @param {API} api
 */
export function createGroupIdGuard(api) {
  let epoch = {};
  /** @type {object | undefined} */
  let cachedEpoch;
  /** @type {Set<number>} */
  let ambiguous = new Set();
  /** @type {Validation | undefined} */
  let validating;

  function invalidate() {
    epoch = {};
    cachedEpoch = undefined;
    ambiguous = new Set();
  }

  /** @param {object} started */
  async function snapshot(started) {
    const groups = await api.tabGroups.query({});
    const seen = new Set();
    const duplicates = new Set();
    for (const { id } of groups) {
      if (seen.has(id)) duplicates.add(id);
      else seen.add(id);
    }
    if (epoch === started) {
      ambiguous = duplicates;
      cachedEpoch = started;
    }
    return { groups, duplicates };
  }

  /** Always read all accessible groups; a filtered result cannot establish ID
   * uniqueness across windows or privacy classes. Return the native array intact.
   * @param {Parameters<typeof browser.tabGroups.query>[0]} [queryInfo]
   * @returns {Promise<browser.tabGroups.TabGroup[]>}
   */
  async function query(queryInfo = {}) {
    if (Object.keys(queryInfo).length) {
      throw new TypeError("Group ID validation requires an unfiltered tabGroups query");
    }
    return (await snapshot(epoch)).groups;
  }

  /** @param {Iterable<number>} ids @returns {Promise<void>} */
  async function validate(ids) {
    const requested = new Set(ids);
    if (!requested.size) return;
    let duplicates = ambiguous;
    if (cachedEpoch !== epoch) {
      if (validating?.epoch !== epoch) {
        const current = {
          epoch,
          promise: snapshot(epoch).then(result => result.duplicates),
        };
        validating = current;
        current.promise = current.promise.finally(() => {
          if (validating === current) validating = undefined;
        });
      }
      duplicates = await validating.promise;
    }
    for (const id of requested) {
      if (duplicates.has(id)) {
        throw new Error(`Firefox reported duplicate native group ID: ${id}`);
      }
    }
  }

  return { invalidate, query, validate };
}
