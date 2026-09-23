import assert from "node:assert/strict";
import test from "node:test";
import { createGroupIdGuard } from "../extension/group-id-guard.js";

function fixture(initial = []) {
  let groups = initial;
  let calls = 0;
  const holds = [];
  const failures = [];
  const arrays = [];
  const api = { tabGroups: {
    async query(info) {
      assert.deepEqual(info, {});
      calls++;
      const result = structuredClone(groups);
      arrays.push(result);
      const held = holds.shift();
      const error = failures.shift();
      held?.entered.resolve();
      await held?.release.promise;
      if (error) throw error;
      return result;
    },
  } };
  return {
    guard: createGroupIdGuard(api), arrays,
    set(next) { groups = next; },
    calls: () => calls,
    fail(error = new Error("Native query failed")) { failures.push(error); },
    hold() {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      holds.push({ entered, release });
      return { entered: entered.promise, release: release.resolve };
    },
  };
}

const group = (id, windowId = 1, title = "name") => ({ id, windowId, title, color: "blue", collapsed: false });

test("bootstrap reads once and subsequent validation caches only ambiguity", async () => {
  const f = fixture([group(1), group(2)]);
  assert.equal(f.calls(), 0);
  await f.guard.validate([1, 2]);
  await f.guard.validate(new Set([1, 2]));
  assert.equal(f.calls(), 1);
});

test("a fresh unfiltered query preserves every native row and warms validation", async () => {
  const f = fixture([group(1), group(1, 2, "second"), group(2)]);
  const raw = await f.guard.query({});
  assert.equal(raw, f.arrays[0]);
  assert.equal(raw.length, 3);
  await assert.rejects(f.guard.validate([1]), /duplicate native group ID: 1/);
  await f.guard.validate([2]);
  assert.equal(f.calls(), 1);
  await f.guard.query();
  assert.equal(f.calls(), 2, "query always reads native state even when validation is cached");
});

test("filtered queries are rejected without poisoning or publishing a partial cache", async () => {
  const f = fixture([group(1), group(1, 2)]);
  await assert.rejects(f.guard.query({ windowId: 1 }), TypeError);
  assert.equal(f.calls(), 0);
  await assert.rejects(f.guard.validate([1]), /duplicate/);
  assert.equal(f.calls(), 1);
});

test("creation invalidation detects a newly colliding ID", async () => {
  const f = fixture([group(1)]);
  await f.guard.validate([1]);
  f.set([group(1), group(1)]);
  f.guard.invalidate();
  await assert.rejects(f.guard.validate([1]), /duplicate/);
  assert.equal(f.calls(), 2);
});

test("validators starting in the same epoch share one snapshot and their own requested IDs", async () => {
  const f = fixture([group(1), group(1), group(2)]);
  const held = f.hold();
  const one = f.guard.validate([1]);
  const two = f.guard.validate([2]);
  const three = f.guard.validate([3]);
  const settled = Promise.allSettled([one, two, three]);
  await held.entered;
  assert.equal(f.calls(), 1);
  held.release();
  assert.deepEqual((await settled).map(result => result.status), ["rejected", "fulfilled", "fulfilled"]);
});

test("old in-flight validation cannot serve or overwrite a new epoch", async () => {
  const f = fixture([group(1)]);
  const held = f.hold();
  const old = f.guard.validate([1]);
  await held.entered;
  f.set([group(1), group(1, 2)]);
  f.guard.invalidate();
  await assert.rejects(f.guard.validate([1]), /duplicate/);
  assert.equal(f.calls(), 2, "new epoch must issue its own native read");
  held.release();
  await old; // Old caller retains its own read/commit boundary.
  await assert.rejects(f.guard.validate([1]), /duplicate/);
  assert.equal(f.calls(), 2, "late old result must not replace the newer cache");
});

test("a raw query invalidated in flight returns its own rows without caching them", async () => {
  const f = fixture([group(1)]);
  const held = f.hold();
  const old = f.guard.query();
  await held.entered;
  f.set([group(1), group(1)]);
  f.guard.invalidate();
  held.release();
  assert.equal((await old).length, 1);
  await assert.rejects(f.guard.validate([1]), /duplicate/);
  assert.equal(f.calls(), 2);
});

test("a failed shared snapshot rejects callers and releases its in-flight state", async () => {
  const f = fixture([group(1)]);
  const failure = new Error("API transport unavailable");
  f.fail(failure);
  const results = await Promise.allSettled([f.guard.validate([1]), f.guard.validate([2])]);
  assert.ok(results.every(result => result.status === "rejected" && result.reason === failure));
  assert.equal(f.calls(), 1);
  await f.guard.validate([1]);
  assert.equal(f.calls(), 2);
});

test("all accessible windows and privacy classes contribute to ambiguity", async () => {
  const f = fixture([
    { ...group(9, 1, "ordinary"), incognito: false },
    { ...group(9, 3, "private"), incognito: true },
    group(10, 4),
  ]);
  await assert.rejects(f.guard.validate([9]), error => /duplicate/.test(error.message) && !error.message.includes("private"));
  await f.guard.validate([10]);
});

test("large native IDs keep full numeric precision and do not alias lower bits", async () => {
  const large = 1_750_000_000_000_001;
  const f = fixture([group(large), group(large), group(large + 2 ** 32)]);
  await assert.rejects(f.guard.validate([large]), new RegExp(String(large)));
  await f.guard.validate([large + 2 ** 32]);
});

test("removal invalidation forgets a resolved collision", async () => {
  const f = fixture([group(1), group(1)]);
  await assert.rejects(f.guard.validate([1]), /duplicate/);
  f.set([group(1)]);
  f.guard.invalidate();
  await f.guard.validate([1]);
  await f.guard.validate([1]);
  assert.equal(f.calls(), 2);
});

test("empty validation has no IPC and requested IDs are captured before waiting", async () => {
  const f = fixture([group(1), group(1)]);
  await f.guard.validate([]);
  assert.equal(f.calls(), 0);
  const held = f.hold();
  const ids = new Set([1]);
  const validation = f.guard.validate(ids);
  const rejected = assert.rejects(validation, /duplicate/);
  await held.entered;
  ids.clear();
  held.release();
  await rejected;
});
