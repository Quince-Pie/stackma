import assert from "node:assert/strict";
import test from "node:test";
import { createStacker } from "../extension/stacker.js";
import { createQueryStacker } from "./query-stacker.js";
import { createModel } from "../tests/model.js";

for (const queryThreshold of [2, 16]) {
  for (const shape of ["siblings", "chain", "independent", "late-parent", "many-idle", "private", "cross-window", "pinned"]) {
    test(`query threshold ${queryThreshold}: ${shape} agrees with per-tab reads`, async () => {
      const tabs = Array.from({ length: shape === "many-idle" ? 512 : 34 }, (_, id) => ({ id, windowId: 1 }));
      if (shape === "private") for (const tab of tabs) tab.incognito = tab.id < 33;
      if (shape === "private") tabs[33].windowId = 2;
      if (shape === "cross-window") tabs[0].windowId = 2;
      if (shape === "pinned") tabs[0].pinned = true;
      const events = Array.from({ length: 32 }, (_, i) => ({
        tabId: i + 1,
        sourceTabId: shape === "chain" || shape === "late-parent" ? i : shape === "independent" ? i % 2 ? i : 0 : 0,
        windowId: 1,
      }));
      if (shape === "late-parent") events.reverse();
      const models = [createModel(tabs), createModel(tabs)];
      const errors = [[], []];
      const engines = [
        createStacker(models[0].api, { onError: e => errors[0].push(e) }),
        createQueryStacker(models[1].api, { queryThreshold, onError: e => errors[1].push(e) }),
      ];
      for (const engine of engines) {
        await Promise.all(events.map(event => engine.enqueue(event)));
        await engine.idle();
      }
      const partition = model => {
        const groups = new Map();
        for (const tab of model.tabs()) {
          const key = tab.groupId < 0 ? `ungrouped:${tab.id}` : tab.groupId;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(tab.id);
        }
        return [...groups.values()].map(ids => ids.sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]);
      };
      assert.deepEqual(partition(models[0]), partition(models[1]));
      assert.deepEqual(errors, [[], []]);
    });
  }
}

test("query failure is retried and then reported without losing queue progress", async () => {
  const model = createModel([1, 2, 3, 4].map(id => ({ id, windowId: 1 })));
  model.failNext("query", new Error("native query failure"));
  model.failNext("query", new Error("native query failure"));
  const errors = [];
  const engine = createQueryStacker(model.api, { onError: error => errors.push(error) });
  await engine.enqueue({ tabId: 2, sourceTabId: 1, windowId: 1 });
  await engine.enqueue({ tabId: 4, sourceTabId: 3, windowId: 1 });
  assert.equal(errors.length, 1);
  assert.equal(model.tab(3).groupId, model.tab(4).groupId);
  assert.ok(model.tab(4).groupId >= 0);
});
