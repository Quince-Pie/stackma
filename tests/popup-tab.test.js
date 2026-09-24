import assert from "node:assert/strict";
import test from "node:test";
import { createLoadedPopup } from "../scripts/popup-tab.js";

function fixture() {
  const event = () => {
    const listeners = new Set();
    return { listeners, addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); },
      emit(details) { for (const fn of listeners) fn(details); } };
  };
  const created = Promise.withResolvers();
  const completed = event(), failed = event();
  const url = "moz-extension://fixture/popup.html";
  const tab = { id: 42, windowId: 3 };
  const calls = [];
  const browser = {
    runtime: { getURL: () => url },
    webNavigation: { onCompleted: completed, onErrorOccurred: failed },
    tabs: { create(options) {
      assert.equal(completed.listeners.size, 1, "Subscribe before creation");
      assert.equal(failed.listeners.size, 1);
      calls.push(options); return created.promise;
    } },
  };
  const details = { tabId: tab.id, frameId: 0, url };
  const cleaned = () => {
    assert.equal(completed.listeners.size, 0);
    assert.equal(failed.listeners.size, 0);
  };
  return { browser, created, completed, failed, tab, url, calls, details, cleaned };
}

test("popup readiness handles completion before the tab creation response", async () => {
  const f = fixture();
  const result = createLoadedPopup(f.browser, f.tab.windowId);
  f.completed.emit(f.details);
  f.created.resolve(f.tab);
  assert.equal(await result, f.tab);
  assert.deepEqual(f.calls, [{ windowId: 3, active: true, url: f.url }]);
  f.cleaned();
});

test("popup readiness ignores other tabs, subframes and unrelated URLs", async () => {
  const f = fixture();
  let settled = false;
  const result = createLoadedPopup(f.browser, 3).then(tab => { settled = true; return tab; });
  f.created.resolve(f.tab);
  f.completed.emit({ ...f.details, tabId: 7 });
  f.completed.emit({ ...f.details, frameId: 1 });
  f.completed.emit({ ...f.details, url: "about:blank" });
  f.failed.emit({ ...f.details, tabId: 7, error: "unrelated" });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  f.completed.emit(f.details);
  assert.equal(await result, f.tab);
  f.cleaned();
});

test("popup navigation failures propagate even before creation resolves", async () => {
  const f = fixture();
  const result = createLoadedPopup(f.browser, 3);
  f.failed.emit({ ...f.details, error: "NS_ERROR_FILE_NOT_FOUND" });
  f.created.resolve(f.tab);
  await assert.rejects(result, /NS_ERROR_FILE_NOT_FOUND/u);
  f.cleaned();
});

test("popup creation rejection preserves the error and removes listeners", async () => {
  const f = fixture(), error = new Error("No such window");
  const result = createLoadedPopup(f.browser, 3);
  f.created.reject(error);
  await assert.rejects(result, candidate => candidate === error);
  f.cleaned();
});

test("popup deadline covers both stalled creation and stalled navigation", async () => {
  for (const creationFinished of [false, true]) {
    const f = fixture();
    const result = createLoadedPopup(f.browser, 3, 5);
    if (creationFinished) f.created.resolve(f.tab);
    await assert.rejects(result, /navigation did not complete/u);
    f.cleaned();
  }
});

test("synchronous API and partial registration failures clean up", async () => {
  for (const registration of [false, true]) {
    const f = fixture(), error = new Error("API unavailable");
    if (registration) f.failed.addListener = () => { throw error; };
    else f.browser.tabs.create = () => { throw error; };
    await assert.rejects(createLoadedPopup(f.browser, 3), candidate => candidate === error);
    f.cleaned();
    assert.equal(f.calls.length, 0);
  }
});
