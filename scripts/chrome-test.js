import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openPromise } from "yauzl";
import { ChromeDriver, MINIMUM_MAJOR } from "./chrome.js";
import { chromePackage } from "./chrome-package.js";
import { readPayload } from "./release/archive.js";
import { artifactNames, brandMetadata } from "./release/package.js";

// Verify the packaged Chrome ZIP in a real browser: exact files, Chrome's own
// manifest diagnostics, link provenance, naming, privacy, wake-up and popup.
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceRoot = resolve(option("source-root") ?? ".");
const firefoxManifest = JSON.parse(await readFile(join(sourceRoot, "extension/manifest.json"), "utf8"));
const zipPath = option("zip") ?? `dist/${artifactNames({ version: firefoxManifest.version, ...brandMetadata(firefoxManifest) }).chrome}`;
const output = resolve(option("output") ?? "artifacts/chrome-tests.json");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
await mkdir(dirname(output), { recursive: true });

const { manifest, entries } = await chromePackage(sourceRoot);
const expected = new Map();
for (const entry of entries) {
  const bytes = entry.path ? await readFile(entry.path) : Buffer.from(entry.content);
  expected.set(entry.name, { sha256: sha256(bytes), bytes: bytes.length });
}
const pairs = new Set(JSON.parse(await readFile(join(sourceRoot, "naming-data/en-v1.json"), "utf8")).pairs
  .map(pair => `${pair.adjective}-${pair.noun}`));

async function extract(path, directory) {
  const zip = await openPromise(resolve(path), { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  try {
    for await (const entry of zip.eachEntry()) {
      assert.match(entry.fileName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "The Chrome package must be flat");
      await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(join(directory, entry.fileName), { flags: "wx" }));
    }
  } finally { zip.close(); }
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Tab Gantry fixture</title><style>a{display:block;font-size:28px;margin:6px}</style>
    <a id="link" target="_blank" href="/target">Related link</a>
    <a id="noreferrer" target="_blank" rel="noreferrer" href="/target">Noreferrer link</a>
    <a id="plain" href="/target">Plain link</a>
    ${["/frame", "/target"].includes(request.url ?? "") ? "" : '<iframe src="/frame"></iframe>'}`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;

const report = { passed: false, zip: zipPath, results: [] };
let driver;
const unpacked = await mkdtemp(join(tmpdir(), "tab-gantry-chrome-package-"));
try {
  const archive = await readFile(zipPath);
  report.bytes = archive.length;
  report.sha256 = sha256(archive);
  report.files = Object.fromEntries([...expected].map(([name, file]) => [name, file.sha256]));
  assert.deepEqual(await readPayload(zipPath), expected, "The Chrome ZIP must contain exactly the frozen source's package");
  await extract(zipPath, unpacked);

  driver = await ChromeDriver.start({ timeoutMs: 30_000, maxLifetimeMs: 600_000 });
  report.chrome = driver.browserVersion;
  report.product = driver.version.product;
  // Developer mode makes Chrome collect manifest and runtime errors.
  const extensions = await driver.page("chrome://extensions");
  await driver.evaluate(extensions.sessionId, () => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const id = await driver.loadExtension(unpacked, { incognito: true });
  const diagnostics = () => driver.evaluate(extensions.sessionId, async extensionId => {
    const info = await chrome.developerPrivate.getExtensionInfo(extensionId);
    return { installWarnings: info.installWarnings, manifestErrors: info.manifestErrors.map(error => error.message),
      runtimeErrors: info.runtimeErrors.map(error => error.message), incognito: info.incognitoAccess.isActive };
  }, id);
  const sw = (fn, ...args) => driver.extension(id, fn, ...args);

  async function test(name, run) {
    const started = performance.now();
    try {
      const details = await run();
      report.results.push({ name, passed: true, durationMs: Math.round(performance.now() - started), details });
      console.log(`PASS ${name}`);
    } catch (error) {
      report.results.push({ name, passed: false, error: String(error) });
      throw error;
    }
  }

  const tabIds = () => sw(async browser => (await browser.tabs.query({})).map(tab => tab.id));
  const inspect = ids => sw(async (browser, ids) => Promise.all(ids.map(async id => {
    const tab = await browser.tabs.get(id);
    const title = tab.groupId >= 0 ? (await browser.tabGroups.get(tab.groupId)).title ?? "" : null;
    return { id, groupId: tab.groupId, windowId: tab.windowId, pinned: tab.pinned, openerTabId: tab.openerTabId ?? null, title };
  })), ids);
  const close = ids => sw((browser, ids) => browser.tabs.remove(ids), ids);
  async function until(check, description, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
      await delay(50);
    }
  }
  /** A fixture tab plus its extension tab ID, found as the only new tab. */
  async function fixture(url = `${base}/`, { newWindow = false } = {}) {
    const before = new Set(await tabIds());
    const page = await driver.page(url, { newWindow });
    await until(() => driver.evaluate(page.sessionId, () => document.readyState === "complete" &&
      (!document.querySelector("iframe") || document.querySelector("iframe").contentDocument?.readyState === "complete")), "the fixture");
    await driver.send("Target.activateTarget", { targetId: page.targetId });
    const created = (await tabIds()).filter(tabId => !before.has(tabId));
    assert.equal(created.length, 1, "Exactly one fixture tab must appear");
    return { ...page, tabId: created[0] };
  }
  async function newTabs(before, count = 1) {
    return until(async () => {
      const created = (await tabIds()).filter(tabId => !before.has(tabId));
      return created.length >= count ? created : null;
    }, `${count} new tab(s)`);
  }
  async function grouped(sourceId, childIds) {
    return until(async () => {
      const tabs = await inspect([sourceId, ...childIds]);
      const [source] = tabs;
      return source.groupId >= 0 && tabs.every(tab => tab.groupId === source.groupId) && source.title ? tabs : null;
    }, "a named group");
  }
  // Settling window for negative checks: longer than any observed grouping.
  const quiet = () => delay(1_500);
  const click = (page, expression) => driver.send("Runtime.evaluate", { expression, userGesture: true }, page.sessionId);

  await test("packaged-files-manifest-and-chrome-diagnostics", async () => {
    const actual = await sw(browser => browser.runtime.getManifest());
    assert.equal(actual.version, firefoxManifest.version);
    assert.equal(actual.name, firefoxManifest.name);
    assert.deepEqual(actual.permissions, ["webNavigation", "tabGroups", "storage"]);
    assert.equal(actual.minimum_chrome_version, String(MINIMUM_MAJOR));
    assert.deepEqual(actual.background, { service_worker: "service-worker.js", type: "module" });
    assert.deepEqual(actual, manifest, "Chrome must load the generated manifest unchanged");
    assert.equal(await sw(browser => typeof browser.webNavigation.onCreatedNavigationTarget.addListener), "function");
    const found = await diagnostics();
    assert.deepEqual(found, { installWarnings: [], manifestErrors: [], runtimeErrors: [], incognito: true });
    return found;
  });

  for (const [name, expression] of [
    ["link", "document.querySelector('#link').click()"],
    ["noreferrer", "document.querySelector('#noreferrer').click()"],
    ["window.open", "window.open('/target', '_blank'); undefined"],
    ["iframe", "document.querySelector('iframe').contentDocument.querySelector('#link').click()"],
  ]) {
    await test(name, async () => {
      const page = await fixture();
      const before = new Set(await tabIds());
      await click(page, expression);
      const [child] = await newTabs(before);
      const tabs = await grouped(page.tabId, [child]);
      assert(pairs.has(tabs[0].title), `Unexpected generated name ${tabs[0].title}`);
      await close([page.tabId, child]);
      return { name: tabs[0].title };
    });
  }

  await test("middle-click", async () => {
    const page = await fixture();
    const box = await driver.evaluate(page.sessionId, () => {
      const rect = document.querySelector("#plain").getBoundingClientRect();
      return { x: rect.x + 10, y: rect.y + rect.height / 2 };
    });
    const before = new Set(await tabIds());
    for (const type of ["mousePressed", "mouseReleased"]) {
      await driver.send("Input.dispatchMouseEvent", { type, ...box, button: "middle", buttons: 4, clickCount: 1 }, page.sessionId);
    }
    const [child] = await newTabs(before);
    const tabs = await grouped(page.tabId, [child]);
    await close([page.tabId, child]);
    return { name: tabs[0].title };
  });

  await test("ctrl-t-is-not-a-link-relationship", async () => {
    const page = await fixture();
    const before = new Set(await tabIds());
    for (const type of ["rawKeyDown", "keyUp"]) {
      await driver.send("Input.dispatchKeyEvent", { type, modifiers: 2, key: "t", code: "KeyT", windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84 }, page.sessionId);
    }
    const [created] = await newTabs(before);
    await quiet();
    const [source, tab] = await inspect([page.tabId, created]);
    // Chrome reports the active tab as this tab's opener; it is not provenance.
    assert.equal(tab.openerTabId, page.tabId, "Chrome's Ctrl+T opener premise changed; revisit the Chrome entry");
    assert.equal(tab.groupId, -1);
    assert.equal(source.groupId, -1);
    await close([page.tabId, created]);
    return { openerTabId: tab.openerTabId };
  });

  await test("duplicate-is-not-a-link-relationship", async () => {
    const page = await fixture();
    const duplicate = await sw(async (browser, tabId) => (await browser.tabs.duplicate(tabId))?.id, page.tabId);
    await quiet();
    const tabs = await inspect([page.tabId, duplicate]);
    assert(tabs.every(tab => tab.groupId === -1));
    await close([page.tabId, duplicate]);
  });

  await test("existing-group-keeps-its-name", async () => {
    const page = await fixture();
    const groupId = await sw(async (browser, tabId) => {
      const group = await browser.tabs.group({ tabIds: [tabId] });
      await browser.tabGroups.update(group, { title: "Research", color: "purple" });
      return group;
    }, page.tabId);
    const before = new Set(await tabIds());
    await click(page, "document.querySelector('#link').click()");
    const [child] = await newTabs(before);
    const tabs = await grouped(page.tabId, [child]);
    await quiet();
    const group = await sw((browser, groupId) => browser.tabGroups.get(groupId), groupId);
    assert.equal(tabs[1].groupId, groupId);
    assert.deepEqual([group.title, group.color], ["Research", "purple"]);
    await close([page.tabId, child]);
  });

  await test("pinned-source-is-left-alone", async () => {
    const page = await fixture();
    await sw((browser, tabId) => browser.tabs.update(tabId, { pinned: true }), page.tabId);
    const before = new Set(await tabIds());
    await click(page, "document.querySelector('#link').click()");
    const [child] = await newTabs(before);
    await quiet();
    const [source, tab] = await inspect([page.tabId, child]);
    assert.deepEqual([source.pinned, source.groupId, tab.groupId], [true, -1, -1]);
    await close([page.tabId, child]);
  });

  await test("separate-window-is-left-alone", async () => {
    const page = await fixture();
    const before = new Set(await tabIds());
    await click(page, "window.open('/target', '_blank', 'popup,width=400,height=300'); undefined");
    const [child] = await newTabs(before);
    await quiet();
    const [source, tab] = await inspect([page.tabId, child]);
    assert.notEqual(source.windowId, tab.windowId);
    assert.deepEqual([source.groupId, tab.groupId], [-1, -1]);
    await sw((browser, windowId) => browser.windows.remove(windowId), tab.windowId);
    await close([page.tabId]);
  });

  await test("burst-joins-one-named-group", async () => {
    const page = await fixture();
    const before = new Set(await tabIds());
    await Promise.all(Array.from({ length: 4 }, () => click(page, "document.querySelector('#link').click()")));
    const children = await newTabs(before, 4);
    const tabs = await grouped(page.tabId, children);
    assert.equal(new Set(tabs.map(tab => tab.title)).size, 1);
    await close([page.tabId, ...children]);
    return { tabs: tabs.length, name: tabs[0].title };
  });

  await test("service-worker-wakes-for-a-link", async () => {
    const page = await fixture();
    const before = new Set(await tabIds());
    await driver.stopWorker(id);
    assert.equal(await driver.hasWorker(id), false);
    // The navigation-target event itself must start the worker.
    await click(page, "document.querySelector('#link').click()");
    await until(() => driver.hasWorker(id), "the service worker to restart");
    const [child] = await newTabs(before);
    const tabs = await grouped(page.tabId, [child]);
    await close([page.tabId, child]);
    return { name: tabs[0].title };
  });

  await test("private-window-names-and-forgets", async () => {
    const targets = async () => (await driver.send("Target.getTargets")).targetInfos.filter(info => info.type === "page");
    const known = new Set((await targets()).map(info => info.targetId));
    const window = await sw(async browser => {
      const created = await browser.windows.create({ incognito: true, focused: false, url: "about:blank" });
      return { id: created.id, tabId: created.tabs[0].id, incognito: created.incognito };
    });
    assert.equal(window.incognito, true);
    const target = await until(async () => (await targets()).find(info => !known.has(info.targetId)), "the private page");
    const { sessionId } = await driver.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const page = { sessionId, targetId: target.targetId, tabId: window.tabId };
    await driver.send("Page.enable", {}, sessionId);
    await driver.send("Page.navigate", { url: `${base}/` }, sessionId);
    await until(() => driver.evaluate(sessionId, () => document.readyState === "complete" && !!document.querySelector("#link")), "the private fixture");
    const before = new Set(await tabIds());
    await click(page, "document.querySelector('#link').click()");
    const [child] = await newTabs(before);
    const tabs = await grouped(window.tabId, [child]);
    const stored = await sw(browser => browser.storage.session.get(["naming.private", "naming.normal"]));
    assert((stored["naming.private"] ?? []).some(entry => entry.name === tabs[0].title && entry.windowId === window.id));
    assert(!(stored["naming.normal"] ?? []).some(entry => entry.name === tabs[0].title), "Private names stay out of normal history");
    await sw((browser, windowId) => browser.windows.remove(windowId), window.id);
    await until(async () => !((await sw(browser => browser.storage.session.get("naming.private")))["naming.private"] ?? [])
      .some(entry => entry.windowId === window.id), "private history removal");
    return { name: tabs[0].title };
  });

  await test("popup-lists-searches-copies-and-opens", async () => {
    const page = await fixture();
    const before = new Set(await tabIds());
    await click(page, "document.querySelector('#link').click()");
    const [child] = await newTabs(before);
    const [source] = await grouped(page.tabId, [child]);
    const origin = `chrome-extension://${id}`;
    await driver.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    const popup = await driver.page(`${origin}/popup.html`);
    const word = source.title.split("-")[1];
    const listed = await until(() => driver.evaluate(popup.sessionId, name => {
      const names = [...document.querySelectorAll(".group-name")].map(node => node.textContent);
      return names.includes(name) ? names : null;
    }, source.title), "the popup list");
    const searched = await driver.evaluate(popup.sessionId, async (word, name) => {
      const search = document.querySelector("#search");
      search.value = word;
      search.dispatchEvent(new Event("input"));
      const visible = [...document.querySelectorAll(".group")].filter(row => !row.hidden)
        .map(row => row.querySelector(".group-name").textContent);
      const row = [...document.querySelectorAll(".group")].find(row => row.querySelector(".group-name").textContent === name);
      row.querySelector("[data-action=copy]").click();
      for (let turn = 0; turn < 100 && document.querySelector("#message").textContent !== "Group name copied."; turn++) {
        await new Promise(done => setTimeout(done, 20));
      }
      return { visible, message: document.querySelector("#message").textContent, clipboard: await navigator.clipboard.readText() };
    }, word, source.title);
    assert(searched.visible.includes(source.title) && searched.visible.every(name => name.includes(word)));
    assert.deepEqual([searched.message, searched.clipboard], ["Group name copied.", source.title]);
    // Open activates a member of the chosen native group.
    await sw((browser, tabId) => browser.tabs.update(tabId, { active: true }), page.tabId);
    await driver.evaluate(popup.sessionId, name => {
      const row = [...document.querySelectorAll(".group")].find(row => row.querySelector(".group-name").textContent === name);
      row.querySelector("[data-action=open]").click();
    }, source.title);
    const active = await until(() => sw(async (browser, groupId) => {
      const [tab] = await browser.tabs.query({ active: true, groupId });
      return tab ? tab.id : null;
    }, source.groupId), "Open group to activate the group");
    assert([page.tabId, child].includes(active));
    await driver.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => {});
    await close([page.tabId, child]);
    return { listed: listed.length, copied: searched.clipboard };
  });

  await test("no-extension-errors", async () => {
    const found = await diagnostics();
    assert.deepEqual(found, { installWarnings: [], manifestErrors: [], runtimeErrors: [], incognito: true });
    const badge = await sw(browser => browser.action.getBadgeText({}));
    assert.equal(badge, "", "No grouping or naming failure may be reported");
  });

  report.passed = true;
  report.checks = report.results.map(result => result.name);
  const packageStats = await stat(zipPath);
  report.bytes = packageStats.size;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Chrome package passed in ${report.chrome}: ${report.bytes} bytes, SHA-256 ${report.sha256}`);
} catch (error) {
  report.error = String(error);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (error && typeof error === "object" && "driverLog" in error && typeof error.driverLog === "string") {
    await writeFile(`${output}.log`, error.driverLog);
  }
  throw error;
} finally {
  server.close();
  if (driver) {
    await driver.close();
    await writeFile(`${output}.log`, driver.logs);
  }
  await rm(unpacked, { recursive: true, force: true });
}
