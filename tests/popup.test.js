import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createPopup } from "../extension/popup.js";

class Element {
  constructor(document, tag = "div") {
    this.document = document;
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children.flatMap(child => child.tagName === "fragment" ? child.children : [child]); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return name.startsWith("data-") ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : this.attributes[name]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { if (!this.disabled) this.listeners.get(name)?.(); }
  focus() { this.document.activeElement = this; }
  scrollIntoView(options) { this.scrolled = options; }
}

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return Promise.all(listeners.map(listener => listener(...args))); },
  };
}

function fixture({ privatePopup = false } = {}) {
  const document = {
    elements: new Map(),
    activeElement: null,
    querySelector(selector) { return this.elements.get(selector); },
    createElement(tag) { return new Element(this, tag); },
    createDocumentFragment() { return new Element(this, "fragment"); },
  };
  for (const id of ["search", "groups", "result-count", "message", "issue", "dismiss", "groups-heading"]) {
    document.elements.set(`#${id}`, new Element(document));
  }
  const windows = [
    { id: 1, incognito: false }, { id: 2, incognito: false }, { id: 3, incognito: true },
  ];
  const groups = [
    { id: 11, windowId: 1, title: "mossy-lantern", color: "blue", collapsed: false },
    { id: 12, windowId: 2, title: "silver-cactus", color: "grey", collapsed: true },
    { id: 13, windowId: 3, title: "sleepy-otter", color: "purple", collapsed: false },
  ];
  const tabs = [
    { id: 101, groupId: 11, windowId: 1, incognito: false, active: false, index: 8 },
    { id: 102, groupId: 11, windowId: 1, incognito: false, active: true, index: 9 },
    { id: 103, groupId: 11, windowId: 1, incognito: false, active: false, index: 2 },
  ];
  const calls = { queries: 0, tabQueries: 0, activated: [], focused: [], copied: [], closed: 0, badge: "!" };
  const api = {
    action: {
      getBadgeText: async () => calls.badge,
      async setBadgeText({ text }) { calls.badge = text; },
    },
    windows: {
      getCurrent: async () => ({ ...windows[privatePopup ? 2 : 0] }),
      getAll: async () => structuredClone(windows),
      get: async id => ({ ...windows.find(window => window.id === id) }),
      async update(id, properties) { calls.focused.push({ id, properties }); },
      onCreated: event(), onRemoved: event(),
    },
    tabGroups: {
      async query() { calls.queries++; return structuredClone(groups); },
      async get(id) {
        const group = groups.find(group => group.id === id);
        if (!group) throw new Error("Group closed");
        return { ...group };
      },
      onCreated: event(), onUpdated: event(), onMoved: event(), onRemoved: event(),
    },
    tabs: {
      async query({ groupId, windowId }) {
        calls.tabQueries++;
        return structuredClone(tabs.filter(tab => tab.groupId === groupId && tab.windowId === windowId));
      },
      get: async id => ({ ...tabs.find(tab => tab.id === id) }),
      async update(id, properties) { calls.activated.push({ id, properties }); },
    },
  };
  const clipboard = { async writeText(text) { calls.copied.push(text); } };
  const popup = createPopup(api, document, clipboard, () => calls.closed++);
  const element = id => document.querySelector(`#${id}`);
  const rows = () => element("groups").children;
  const action = (index, type) => rows()[index].children[2].children[type === "copy" ? 1 : 0];
  return { api, document, calls, groups, tabs, windows, clipboard, popup, element, rows, action };
}

test("popup keeps native names and scope; literal component search never navigates", async () => {
  const f = fixture();
  await f.popup.idle();
  assert.deepEqual(f.rows().map(row => row.children[0].textContent), ["mossy-lantern", "silver-cactus"]);
  assert.equal(f.rows()[0].children[1].textContent, "This window · blue · Expanded");
  assert.equal(f.rows()[1].children[1].textContent, "Window 1 · grey · Collapsed");
  assert.equal(f.calls.tabQueries, 0, "display must not enumerate group membership");
  for (const [query, shown] of [["MOSSY", 0], ["cactus", 1]]) {
    f.element("search").value = query;
    f.element("search").dispatch("input");
    assert.deepEqual(f.rows().map(row => row.hidden), [shown !== 0, shown !== 1]);
  }
  f.element("search").value = "moss.*";
  f.element("search").dispatch("input");
  assert.ok(f.rows().every(row => row.hidden));
  assert.equal(f.element("result-count").textContent, "No group names match.");
  assert.deepEqual(f.calls.activated, []);
});

test("private popup excludes ordinary windows", async () => {
  const f = fixture({ privatePopup: true });
  await f.popup.idle();
  assert.deepEqual(f.rows().map(row => row.children[0].textContent), ["sleepy-otter"]);
  assert.equal(f.element("groups-heading").textContent, "Open private groups");
});

test("full manual title is text and copied synchronously without regeneration", async () => {
  const f = fixture();
  const title = '<img src=x onerror="throw 1"> a long manual name '.repeat(8);
  f.groups[0].title = title;
  await f.popup.idle();
  assert.equal(f.rows()[0].children[0].textContent, title);
  f.groups[0].title = "changed behind the popup";
  f.action(0, "copy").dispatch("click");
  assert.deepEqual(f.calls.copied, [title], "clipboard request must happen within the click task");
  await setImmediate();
  assert.equal(f.element("message").textContent, "Group name copied.");
});

test("unnamed manual groups are visible and are never named or copied as a placeholder", async () => {
  const f = fixture();
  f.groups[0].title = "";
  await f.popup.idle();
  assert.equal(f.rows()[0].children[0].textContent, "Unnamed group");
  assert.equal(f.action(0, "copy").disabled, true);
  assert.equal(f.groups[0].title, "");
});

test("explicit navigation uses the active native member and then focuses its window", async () => {
  const f = fixture();
  await f.popup.idle();
  f.action(0, "open").dispatch("click");
  await setImmediate();
  assert.deepEqual(f.calls.activated, [{ id: 102, properties: { active: true } }]);
  assert.deepEqual(f.calls.focused, [{ id: 1, properties: { focused: true } }]);
  assert.equal(f.calls.closed, 1);
});

test("navigation uses lowest tab index when no member is active", async () => {
  const f = fixture();
  f.tabs[1].active = false;
  await f.popup.idle();
  f.action(0, "open").dispatch("click");
  await setImmediate();
  assert.equal(f.calls.activated[0].id, 103);
});

test("stale title refreshes without activating another entity", async () => {
  const f = fixture();
  await f.popup.idle();
  f.groups[0].title = "manual-rename";
  f.action(0, "open").dispatch("click");
  await setImmediate();
  assert.deepEqual(f.calls.activated, []);
  assert.deepEqual(f.calls.focused, []);
  assert.equal(f.rows()[0].children[0].textContent, "manual-rename");
  assert.match(f.element("message").textContent, /changed/);
});

test("member moved between enumeration and commit is not activated", async () => {
  const f = fixture();
  f.api.tabs.get = async id => ({ ...f.tabs.find(tab => tab.id === id), groupId: 999 });
  await f.popup.idle();
  f.action(0, "open").dispatch("click");
  await setImmediate();
  assert.deepEqual(f.calls.activated, []);
  assert.match(f.element("message").textContent, /changed/);
});

test("a group renamed during member enumeration requires another explicit choice", async () => {
  const f = fixture();
  const query = f.api.tabs.query;
  f.api.tabs.query = async info => {
    const members = await query(info);
    f.groups[0].title = "new-manual-title";
    return members;
  };
  await f.popup.idle();
  f.action(0, "open").dispatch("click");
  await setImmediate();
  assert.deepEqual(f.calls.activated, []);
  assert.deepEqual(f.calls.focused, []);
  assert.equal(f.rows()[0].children[0].textContent, "new-manual-title");
});

test("closed groups and unavailable native metadata report errors without navigation", async t => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  await f.popup.idle();
  f.groups.shift();
  f.action(0, "open").dispatch("click");
  await setImmediate();
  assert.deepEqual(f.calls.activated, []);
  assert.equal(f.rows().length, 1);
  assert.equal(f.element("message").dataset.error, "true");
  f.api.tabGroups.query = async () => { throw new Error("Groups unavailable"); };
  await f.popup.refresh();
  assert.deepEqual(f.rows(), []);
  assert.equal(f.element("result-count").textContent, "Groups are unavailable.");
});

test("native events coalesce and preserve focused control across title changes", async () => {
  const f = fixture();
  await f.popup.idle();
  f.action(0, "copy").focus();
  f.groups[0].title = "manual-title";
  await Promise.all(Array.from({ length: 20 }, () => f.api.tabGroups.onUpdated.emit()));
  assert.equal(f.calls.queries, 2);
  assert.equal(f.document.activeElement, f.action(0, "copy"));
  assert.deepEqual(f.document.activeElement.scrolled, { block: "nearest" });
  assert.equal(f.rows()[0].children[0].textContent, "manual-title");
});

test("failure messages are visible and badge dismissal follows successful write", async t => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  f.clipboard.writeText = () => Promise.reject(new Error("Clipboard blocked"));
  await f.popup.idle();
  f.action(0, "copy").dispatch("click");
  await setImmediate();
  assert.match(f.element("message").textContent, /copy.*manually/);
  assert.equal(f.element("message").dataset.error, "true");
  f.api.action.setBadgeText = async () => { throw new Error("Badge blocked"); };
  f.element("dismiss").dispatch("click");
  await setImmediate();
  assert.equal(f.element("issue").hidden, false);
  assert.equal(f.element("dismiss").disabled, false);
  f.api.action.setBadgeText = async () => {};
  f.element("dismiss").dispatch("click");
  await setImmediate();
  assert.equal(f.element("issue").hidden, true);
});

for (const windowId of [1, 2, 3]) {
  test(`duplicate group IDs in window ${windowId} disable navigation without exposing other privacy titles`, async () => {
    const f = fixture();
    const duplicateTitle = windowId === 3 ? "private-title-not-for-display" : "different-manual-group";
    f.groups.push({ id: 11, windowId, title: duplicateTitle, color: "red", collapsed: false });
    await f.popup.idle();
    const colliding = f.rows().filter(row => row.children[2].children[0].dataset.groupId === "11");
    assert.equal(colliding.length, windowId === 3 ? 1 : 2);
    for (const row of colliding) {
      assert.equal(row.children[2].children[0].disabled, true);
      assert.equal(row.children[2].children[1].disabled, false);
    }
    assert.match(f.element("message").textContent, /Firefox cannot distinguish/);
    assert.ok(!f.element("message").textContent.includes(duplicateTitle));
    if (windowId === 3) assert.ok(f.rows().every(row => row.children[0].textContent !== duplicateTitle));
    f.action(0, "open").dispatch("click");
    assert.deepEqual(f.calls.activated, []);
    f.action(0, "copy").dispatch("click");
    assert.deepEqual(f.calls.copied, ["mossy-lantern"]);
  });
}

test("an ID collision introduced after rendering is caught by the explicit-open snapshot", async () => {
  const f = fixture();
  await f.popup.idle();
  assert.equal(f.action(0, "open").disabled, false);
  f.groups.push({ ...f.groups[0], windowId: 2, title: "newly-colliding-group" });
  f.action(0, "open").dispatch("click");
  await setImmediate();
  assert.deepEqual(f.calls.activated, []);
  assert.deepEqual(f.calls.focused, []);
  assert.equal(f.calls.closed, 0);
  for (const row of f.rows().filter(row => row.children[2].children[0].dataset.groupId === "11")) {
    assert.equal(row.children[2].children[0].disabled, true, "finally must not re-enable ambiguous controls");
  }
  assert.match(f.element("message").textContent, /Firefox cannot distinguish/);
});

test("a collision appearing during tab enumeration prevents even same-title same-window selection", async () => {
  const f = fixture();
  const query = f.api.tabs.query;
  f.api.tabs.query = async info => {
    const members = await query(info);
    f.groups.push({ ...f.groups[0] });
    return members;
  };
  await f.popup.idle();
  f.action(0, "open").dispatch("click");
  await setImmediate();
  assert.deepEqual(f.calls.activated, []);
  assert.deepEqual(f.calls.focused, []);
  assert.match(f.element("message").textContent, /Firefox cannot distinguish/);
});
