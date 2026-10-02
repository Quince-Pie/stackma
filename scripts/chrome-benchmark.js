import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, cpus, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChromeDriver } from "./chrome.js";

// Chrome qualification of the stacker and of Chrome's relationship entry.
// --suite=stackers mirrors scripts/benchmark.js admission on Firefox: the same
// six candidates, scenarios, warm-ups and rotating order. --suite=entry clicks
// real links and compares the delivered window lookup (lookup) with a window
// cache fed by tabs.onCreated (created-cache), each freshly installed per block.
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const suite = option("suite", "stackers");
const phase = option("phase", "exploratory");
assert(["stackers", "entry"].includes(suite) && ["exploratory", "confirmation"].includes(phase));
const repetitions = phase === "confirmation" ? 12 : 3;
const warmups = phase === "confirmation" ? 2 : 1;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const report = {
  suite, phase, repetitions, warmups, date: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
  hardware: { architecture: arch(), kernel: release(), logicalCpus: cpus().length, ramBytes: totalmem() },
  samples: [], setup: [], sources: {},
};
const fixtureRoot = await mkdtemp(join(tmpdir(), "tab-gantry-chrome-benchmark-"));
const production = ["core.js", "stacker.js", "namer.js", "group-id-guard.js", "name-generator.js", "name-catalog.js"];
for (const file of [...production.map(name => `extension/${name}`), "experiments/query-stacker.js", "experiments/dependency-stacker.js", "chrome/extension/service-worker.js"]) {
  report.sources[file] = sha256(await readFile(file));
}

// A helper that owns fixture windows and cleanup. It registers no events.
async function writeHelper(directory) {
  await mkdir(directory);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Benchmark helper", version: "1.0.0", minimum_chrome_version: "148",
    permissions: ["tabs", "tabGroups"], background: { service_worker: "helper.js", type: "module" },
  }));
  await writeFile(join(directory, "helper.js"), "// Driven over CDP only.\n");
}

async function writeStackerFixture(directory) {
  await mkdir(directory);
  await cp("extension/stacker.js", join(directory, "stacker.js"));
  await cp("experiments/query-stacker.js", join(directory, "query-stacker.js"));
  await cp("experiments/dependency-stacker.js", join(directory, "dependency-stacker.js"));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Tab Gantry isolated benchmark", version: "1.0.0", minimum_chrome_version: "148",
    permissions: ["tabGroups"], background: { service_worker: "benchmark.js", type: "module" },
  }));
  await writeFile(join(directory, "benchmark.js"), `
import { createStacker } from './stacker.js';
import { createQueryStacker } from './query-stacker.js';
import { createStacker as createDependencyStacker } from './dependency-stacker.js';
const factories = {
  fifo: api => createStacker(api, { batchSize: 1, onError: fail }),
  batch: api => createStacker(api, { onError: fail }),
  'wide-batch': api => createStacker(api, { batchSize: 128, onError: fail }),
  query: api => createQueryStacker(api, { onError: fail }),
  'selective-query': api => createQueryStacker(api, { queryThreshold: 16, onError: fail }),
  dependency: api => createDependencyStacker(api, { onError: fail }),
};
let failures = [];
function fail(error) { failures.push(String(error)); }
globalThis.tabGantryBenchmark = async function(variant, ids, shape) {
  const calls = { get: 0, query: 0, group: 0, move: 0, records: 0 };
  const api = { tabs: {} };
  for (const name of ['get', 'query', 'group', 'move']) {
    api.tabs[name] = async (...args) => {
      calls[name]++;
      const result = await browser.tabs[name](...args);
      if (name !== 'group') calls.records += Array.isArray(result) ? result.length : 1;
      return result;
    };
  }
  const siblingCount = Number(shape.match(/^siblings(\\d+)$/)?.[1] ?? 0);
  const edges = shape === 'single' ? [[0,1]] : siblingCount
    ? Array.from({length:siblingCount},(_,i)=>[0,i+1]) : shape === 'chain32'
    ? Array.from({length:32},(_,i)=>[i,i+1]) : Array.from({length:16},(_,i)=>[i*2,i*2+1]);
  const windowId = (await browser.tabs.get(ids[0])).windowId;
  failures = [];
  const start = performance.now();
  const current = factories[variant](api);
  await Promise.all(edges.map(([parent,child]) => current.enqueue({tabId:ids[child],sourceTabId:ids[parent],windowId})));
  await current.idle();
  const elapsedMs = performance.now() - start;
  if (failures.length) throw new Error(failures.join('; '));
  const retained = current.diagnostics();
  const groups = new Map((await browser.tabs.query({windowId})).map(tab=>[tab.id,tab.groupId]));
  for (const [parent,child] of edges) {
    if (groups.get(ids[parent]) < 0 || groups.get(ids[parent]) !== groups.get(ids[child])) throw new Error('Membership oracle failed');
  }
  const cleanupStart = performance.now();
  for (const id of ids) current.forget(id);
  const cleaned = current.diagnostics();
  await browser.tabs.ungroup(ids);
  return { elapsedMs, cleanupMs: performance.now() - cleanupStart, calls, retained, cleaned };
};
`);
}

// The delivered Chrome entry and its cache challenger around the production
// core. Both record the same marks through the same counting wrapper.
const entrySource = variant => `
import { start } from './core.js';
import { missingTab } from './stacker.js';
const clock = () => performance.timeOrigin + performance.now();
const marks = [];
const calls = {};
const waiters = new Set();
globalThis.benchState = { marks, calls, starts: 1, createdEvents: 0 };
function wrap(namespace, name, methods) {
  const wrapper = Object.create(namespace);
  for (const method of methods) {
    wrapper[method] = async (...args) => {
      calls[name + '.' + method] = (calls[name + '.' + method] ?? 0) + 1;
      const result = await namespace[method](...args);
      if (name === 'tabs' && method === 'group') mark(['group', clock(), result]);
      if (name === 'tabGroups' && method === 'update' && args[1]?.title) mark(['title', clock(), args[0]]);
      return result;
    };
  }
  return wrapper;
}
function mark(entry) {
  marks.push(entry);
  for (const waiter of waiters) waiter();
}
const api = new Proxy(browser, { get(target, name) {
  if (name === 'tabs') return tabs;
  if (name === 'tabGroups') return tabGroups;
  if (name === 'windows') return windows;
  return target[name];
} });
const tabs = wrap(browser.tabs, 'tabs', ['get', 'query', 'group', 'move']);
const tabGroups = wrap(browser.tabGroups, 'tabGroups', ['get', 'query', 'update']);
const windows = wrap(browser.windows, 'windows', ['getAll']);
const { stacker, onError } = start(api);
${variant === "lookup" ? `
browser.webNavigation.onCreatedNavigationTarget.addListener(details => {
  mark(['target', clock(), details.tabId]);
  void tabs.get(details.tabId).then(
    tab => { mark(['enqueue', clock(), details.tabId]); return stacker.enqueue({ tabId: details.tabId, sourceTabId: details.sourceTabId, windowId: tab.windowId }); },
    error => { if (!missingTab(error)) onError(error); },
  ).then(() => mark(['done', clock(), details.tabId]));
});` : `
const created = new Map();
browser.tabs.onCreated.addListener(tab => {
  globalThis.benchState.createdEvents++;
  created.set(tab.id, tab.windowId);
  if (created.size > 1024) created.delete(created.keys().next().value);
});
browser.tabs.onRemoved.addListener(tabId => created.delete(tabId));
browser.webNavigation.onCreatedNavigationTarget.addListener(details => {
  mark(['target', clock(), details.tabId]);
  const windowId = created.get(details.tabId);
  created.delete(details.tabId);
  if (windowId !== undefined) {
    mark(['enqueue', clock(), details.tabId]);
    void stacker.enqueue({ tabId: details.tabId, sourceTabId: details.sourceTabId, windowId }).then(() => mark(['done', clock(), details.tabId]));
    return;
  }
  void tabs.get(details.tabId).then(
    tab => { mark(['enqueue', clock(), details.tabId]); return stacker.enqueue({ tabId: details.tabId, sourceTabId: details.sourceTabId, windowId: tab.windowId }); },
    error => { if (!missingTab(error)) onError(error); },
  ).then(() => mark(['done', clock(), details.tabId]));
});`}
browser.storage.session.get('starts').then(({ starts = 0 }) => browser.storage.session.set({ starts: starts + 1 }));
globalThis.benchReset = () => { marks.length = 0; for (const key of Object.keys(calls)) delete calls[key]; };
globalThis.benchWait = count => new Promise(resolve => {
  const check = () => {
    if (marks.filter(entry => entry[0] === 'done').length >= count) { waiters.delete(check); resolve({ marks: [...marks], calls: { ...calls } }); }
  };
  waiters.add(check);
  check();
});
`;

async function writeEntryFixture(directory, variant) {
  await mkdir(directory);
  for (const file of production) await cp(`extension/${file}`, join(directory, file));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: `Tab Gantry entry ${variant}`, version: "1.0.0", minimum_chrome_version: "148",
    permissions: ["webNavigation", "tabGroups", "storage"], background: { service_worker: "entry.js", type: "module" },
  }));
  await writeFile(join(directory, "entry.js"), entrySource(variant));
}

let driver;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><title>fixture</title><a id="link" target="_blank" href="/target">link</a>');
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
try {
  driver = await ChromeDriver.start({ timeoutMs: 180_000, startupTimeoutMs: 60_000, maxLifetimeMs: 3 * 3_600_000 });
  report.browser = { version: driver.browserVersion, product: driver.version.product };
  await writeHelper(join(fixtureRoot, "helper"));
  const helper = await driver.loadExtension(join(fixtureRoot, "helper"));
  const help = (fn, ...args) => driver.extension(helper, fn, ...args);

  if (suite === "stackers") {
    const variants = option("variants", "fifo,batch,wide-batch,query,selective-query,dependency").split(",");
    report.variants = variants;
    await writeStackerFixture(join(fixtureRoot, "stackers"));
    const id = await driver.loadExtension(join(fixtureRoot, "stackers"));
    const pools = new Map();
    for (const size of [2, 33, 40, 512]) {
      const started = performance.now();
      pools.set(size, await help(async (browser, count) => {
        const window = await browser.windows.create({ focused: true, url: "about:blank" });
        const ids = [window.tabs[0].id];
        for (let offset = 1; offset < count; offset += 32) {
          const tabs = await Promise.all(Array.from({ length: Math.min(32, count - offset) }, () =>
            browser.tabs.create({ windowId: window.id, active: false, url: "about:blank" })));
          ids.push(...tabs.map(tab => tab.id));
        }
        return ids;
      }, size));
      report.setup.push({ tabs: size, elapsedMs: performance.now() - started });
    }
    const scenarios = [[2, "single"], [33, "siblings32"], [40, "single"], [40, "siblings32"], [40, "chain32"],
      [40, "independent16"], [512, "single"], [512, "siblings32"], [512, "siblings128"]];
    for (const [tabs, shape] of scenarios) {
      for (let repetition = -warmups; repetition < repetitions; repetition++) {
        const rotation = (repetition + warmups) % variants.length;
        const cycle = Math.floor((repetition + warmups) / variants.length) % 2 ? variants.toReversed() : variants;
        const order = [...cycle.slice(rotation), ...cycle.slice(0, rotation)];
        for (const variant of order) {
          const sample = await driver.extension(id, (browser, variant, ids, shape) =>
            globalThis.tabGantryBenchmark(variant, ids, shape), variant, pools.get(tabs), shape);
          if (repetition >= 0) report.samples.push({ tabs, shape, repetition, variant, ...sample });
        }
      }
      console.log(`${phase}: admission / ${tabs} tabs / ${shape}`);
    }
  } else {
    const variants = ["lookup", "created-cache"];
    report.variants = variants;
    for (const variant of variants) await writeEntryFixture(join(fixtureRoot, variant), variant);
    // One fixture page per window size; extra about:blank tabs share its window.
    const pools = new Map();
    for (const size of [2, 40, 512]) {
      const started = performance.now();
      const page = await driver.page(`${base}/`, { newWindow: true });
      await driver.send("Target.activateTarget", { targetId: page.targetId });
      const known = [...pools.values()].map(pool => pool.source.id);
      const source = await help(async (browser, url, known) => {
        const tabs = (await browser.tabs.query({ url })).filter(tab => !known.includes(tab.id));
        if (tabs.length !== 1) throw new Error("Cannot identify the fixture tab");
        return tabs[0];
      }, `${base}/`, known);
      await help(async (browser, windowId, count) => {
        for (let offset = 1; offset < count; offset += 32) {
          await Promise.all(Array.from({ length: Math.min(32, count - offset) }, () =>
            browser.tabs.create({ windowId, active: false, url: "about:blank" })));
        }
      }, source.windowId, size);
      pools.set(size, { page, source });
      report.setup.push({ tabs: size, elapsedMs: performance.now() - started });
    }
    const clickTime = async (page, count) => {
      const results = await Promise.all(Array.from({ length: count }, () => driver.send("Runtime.evaluate", {
        expression: "(() => { const t = performance.timeOrigin + performance.now(); document.querySelector('#link').click(); return t; })()",
        userGesture: true, returnByValue: true,
      }, page.sessionId)));
      return Math.min(...results.map(result => result.result.value));
    };
    // Each measured sample: fresh install, one discarded warm sample, then one
    // measured sample; cold samples stop the worker before the measured click.
    async function sample(variant, tabs, shape) {
      const id = await driver.loadExtension(join(fixtureRoot, variant));
      const { page, source } = pools.get(tabs);
      const count = shape === "burst8" ? 8 : 1;
      const run = async cold => {
        const before = new Set(await help(async browser => (await browser.tabs.query({})).map(tab => tab.id)));
        await driver.extension(id, () => globalThis.benchReset());
        if (cold) await driver.stopWorker(id);
        await driver.send("Target.activateTarget", { targetId: page.targetId });
        const clicked = await clickTime(page, count);
        const result = await driver.extension(id, (browser, count) => globalThis.benchWait(count), count);
        const created = await help(async (browser, before, count) => {
          for (let turn = 0; turn < 400; turn++) {
            const ids = (await browser.tabs.query({})).map(tab => tab.id).filter(tabId => !before.includes(tabId));
            if (ids.length >= count) return ids;
            await new Promise(done => setTimeout(done, 5));
          }
          throw new Error("Link targets did not appear");
        }, [...before], count);
        // All targets must join the source's group before the sample completes.
        const grouped = await help(async (browser, sourceId, created) => {
          for (let turn = 0; turn < 2000; turn++) {
            const tabs = await Promise.all([sourceId, ...created].map(tabId => browser.tabs.get(tabId)));
            if (tabs[0].groupId >= 0 && tabs.every(tab => tab.groupId === tabs[0].groupId)) {
              return (await browser.tabGroups.get(tabs[0].groupId)).title;
            }
            await new Promise(done => setTimeout(done, 5));
          }
          throw new Error("Membership oracle failed");
        }, source.id, created);
        assert.match(grouped, /^[a-z]+-[a-z]+$/u);
        const final = await driver.extension(id, (browser, count) => globalThis.benchWait(count), count);
        await help(async (browser, sourceId, created) => { await browser.tabs.remove(created); await browser.tabs.ungroup(sourceId); }, source.id, created);
        const at = name => final.marks.find(entry => entry[0] === name)?.[1];
        const last = name => Math.max(...final.marks.filter(entry => entry[0] === name).map(entry => entry[1]));
        return {
          targetMs: at("target") - clicked, enqueueMs: at("enqueue") - clicked,
          groupMs: at("group") - clicked, titleMs: at("title") - clicked, doneMs: last("done") - clicked,
          calls: result.calls, created: created.length,
        };
      };
      await run(false);
      const measured = await run(shape === "cold");
      await driver.send("Extensions.uninstall", { id });
      return measured;
    }
    const scenarios = [[2, "single"], [40, "single"], [512, "single"], [40, "burst8"], [40, "cold"], [512, "cold"]];
    for (const [tabs, shape] of scenarios) {
      for (let repetition = -warmups; repetition < repetitions; repetition++) {
        const order = (repetition + warmups) % 2 ? variants.toReversed() : variants;
        for (const variant of order) {
          const result = await sample(variant, tabs, shape);
          if (repetition >= 0) report.samples.push({ tabs, shape, repetition, variant, ...result });
        }
      }
      console.log(`${phase}: entry / ${tabs} tabs / ${shape}`);
    }
    // Structural lifecycle cost: unrelated tabs created while the worker sleeps.
    for (const variant of variants) {
      const id = await driver.loadExtension(join(fixtureRoot, variant));
      const { page } = pools.get(40);
      await delay(500);
      const startsBefore = (await driver.extension(id, browser => browser.storage.session.get("starts"))).starts;
      await driver.stopWorker(id);
      const before = new Set(await help(async browser => (await browser.tabs.query({})).map(tab => tab.id)));
      for (let index = 0; index < 20; index++) {
        await driver.send("Target.activateTarget", { targetId: page.targetId });
        for (const type of ["rawKeyDown", "keyUp"]) {
          await driver.send("Input.dispatchKeyEvent", { type, modifiers: 2, key: "t", code: "KeyT", windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84 }, page.sessionId);
        }
        await delay(50);
      }
      await delay(1_000);
      const created = await help(async (browser, before) => (await browser.tabs.query({})).map(tab => tab.id).filter(tabId => !before.includes(tabId)), [...before]);
      const woke = await driver.hasWorker(id);
      const state = woke ? await driver.extension(id, browser => browser.storage.session.get("starts").then(({ starts }) => ({ starts, createdEvents: globalThis.benchState.createdEvents }))) : null;
      report.lifecycle = [...(report.lifecycle ?? []), { variant, unrelatedTabs: created.length, workerRunningAfter: woke,
        workerStarts: state ? state.starts - startsBefore : 0, createdEventsReceived: state?.createdEvents ?? 0 }];
      await help(async (browser, created) => browser.tabs.remove(created), created);
      await driver.send("Extensions.uninstall", { id });
    }
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(`artifacts/chrome-benchmark-${suite}-${phase}.json`, JSON.stringify(report, null, 2) + "\n");
  server.close();
  if (driver) {
    await driver.close();
    await writeFile(`artifacts/chrome-benchmark-${suite}-${phase}.log`, driver.logs);
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}
