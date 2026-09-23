import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus, totalmem, arch, release } from "node:os";
import { join, resolve } from "node:path";
import { FirefoxDriver } from "./webdriver.js";

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const phase = option("phase", "exploratory");
if (!["exploratory", "confirmation"].includes(phase)) throw new Error("Unknown phase");
const variants = option("variants", "fifo,batch,wide-batch,query,selective-query,dependency").split(",");
const repetitions = phase === "confirmation" ? 12 : 3;
const warmups = phase === "confirmation" ? 2 : 1;
const fixture = await mkdtemp(join(tmpdir(), "stackma-benchmark-"));
const report = {
  phase, variants, repetitions, warmups, date: new Date().toISOString(),
  node: process.version, cpu: cpus()[0].model,
  hardware: { architecture: arch(), kernel: release(), logicalCpus: cpus().length, ramBytes: totalmem() },
  samples: [], setup: [], sources: {},
  scope: "Native API completion; component admission and real tabs.create-to-handler completion measured separately. No UI paint claim.",
};
let driver;
try {
  const production = await readFile("extension/stacker.js");
  report.kernelSha256 = createHash("sha256").update(production).digest("hex");
  for (const file of ["extension/stacker.js", "experiments/query-stacker.js", "experiments/dependency-stacker.js"]) {
    report.sources[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  await cp("extension/stacker.js", join(fixture, "stacker.js"));
  await cp("experiments/query-stacker.js", join(fixture, "query-stacker.js"));
  if (variants.includes("dependency")) await cp("experiments/dependency-stacker.js", join(fixture, "dependency-stacker.js"));
  await writeFile(join(fixture, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Stackma isolated benchmark", version: "1.0.0",
    permissions: ["webNavigation"],
    background: { scripts: ["benchmark.js"], type: "module" },
    browser_specific_settings: { gecko: { id: "stackma-benchmark@extensions.local", strict_min_version: "156.0", data_collection_permissions: { required: ["none"] } } },
  }));
  await writeFile(join(fixture, "benchmark.js"), `
import { createStacker } from './stacker.js';
import { createQueryStacker } from './query-stacker.js';
${variants.includes("dependency") ? "import { createStacker as createDependencyStacker } from './dependency-stacker.js';" : ""}
const factories = {
  fifo: api => createStacker(api, { batchSize: 1, onError: fail }),
  batch: api => createStacker(api, { onError: fail }),
  'wide-batch': api => createStacker(api, { batchSize: 128, onError: fail }),
  query: api => createQueryStacker(api, { onError: fail }),
  'selective-query': api => createQueryStacker(api, { queryThreshold: 16, onError: fail }),
  ${variants.includes("dependency") ? "dependency: api => createDependencyStacker(api, { onError: fail })," : ""}
};
let current;
let failures = [];
let events;
function fail(error) { failures.push(String(error)); }
function receive(relation) {
  if (!current || !Number.isInteger(relation.sourceTabId) || !events || events.seen.has(relation.tabId)) return;
  events.seen.add(relation.tabId);
  return current.enqueue(relation).then(() => {
    events.done++;
    if (events.done === events.expected) events.resolve();
  });
}
browser.tabs.onCreated.addListener(tab => receive({tabId:tab.id,sourceTabId:tab.openerTabId,windowId:tab.windowId}));
browser.webNavigation.onCreatedNavigationTarget.addListener(details => receive(details));
browser.tabs.onRemoved.addListener(id => current?.forget(id));
globalThis.stackmaBenchmark = async function(variant, ids, shape, flow) {
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
  const before = await browser.tabs.get(ids[0]);
  const windowId = before.windowId;
  failures = [];
  events = flow ? {...Promise.withResolvers(), seen:new Set(), done:0, expected:edges.length} : null;
  const created = [];
  const start = performance.now();
  current = factories[variant](api);
  if (flow) {
    if (shape === 'chain32') {
      let parent = ids[0];
      for (let i=0;i<32;i++) {
        const child = await browser.tabs.create({active:false,windowId,openerTabId:parent});
        created.push(child.id);
        parent = child.id;
      }
    } else {
      const children = await Promise.all(edges.map(([parent]) => browser.tabs.create({active:false,windowId,openerTabId:ids[parent]})));
      created.push(...children.map(tab=>tab.id));
    }
    await events.promise;
    await current.idle();
  } else {
    await Promise.all(edges.map(([parent,child]) => current.enqueue({tabId:ids[child],sourceTabId:ids[parent],windowId})));
    await current.idle();
  }
  const elapsedMs = performance.now() - start;
  if (failures.length) throw new Error(failures.join('; '));
  const retained = current.diagnostics();
  const snapshot = await browser.tabs.query({windowId});
  const groups = new Map(snapshot.map(tab=>[tab.id,tab.groupId]));
  const checkedEdges = flow ? (shape === 'chain32'
    ? created.map((child,i)=>[i ? created[i-1] : ids[0], child])
    : edges.map(([parent],i)=>[ids[parent],created[i]])) : edges.map(([parent,child])=>[ids[parent],ids[child]]);
  for (const [parent,child] of checkedEdges) {
    if (groups.get(parent) < 0 || groups.get(parent) !== groups.get(child)) throw new Error('Membership oracle failed');
  }
  const cleanupStart = performance.now();
  for (const id of [...ids,...created]) current.forget(id);
  const cleaned = current.diagnostics();
  current = null;
  events = null;
  if (created.length) await browser.tabs.remove(created);
  await browser.tabs.ungroup(ids);
  const cleanupMs = performance.now() - cleanupStart;
  return { elapsedMs, cleanupMs, calls, retained, cleaned };
};
`);
  driver = await FirefoxDriver.start({
    timeoutMs: 60_000, startupTimeoutMs: 45_000, maxLifetimeMs: 900_000,
    prefs: { "privacy.reduceTimerPrecision": false },
  });
  const id = await driver.installAddon(fixture);
  report.browser = {
    version: driver.capabilities.browserVersion,
    buildId: driver.capabilities["moz:buildID"],
    geckodriver: driver.capabilities["moz:geckodriverVersion"],
  };
  const extra = await driver.chrome(async addonId => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return (await AddonManager.getAddonsByTypes(["extension"]))
      .filter(addon => addon.isActive && !addon.isSystem && !addon.isBuiltin && addon.id !== addonId)
      .map(addon => addon.id);
  }, id);
  assert.deepEqual(extra, [], "Interfering extension in benchmark profile");
  const pools = new Map();
  for (const size of [2, 33, 40, 512]) {
    const start = performance.now();
    const pool = await driver.addon(id, async (browser, count) => {
      const window = await browser.windows.create({ focused: true });
      const ids = [window.tabs[0].id];
      for (let offset = 1; offset < count; offset += 32) {
        const tabs = await Promise.all(Array.from({length:Math.min(32,count-offset)}, () => browser.tabs.create({windowId:window.id,active:false})));
        ids.push(...tabs.map(tab=>tab.id));
      }
      return ids;
    }, size);
    pools.set(size, pool);
    report.setup.push({ tabs: size, elapsedMs: performance.now() - start });
  }
  const scenarios = [
    [2, "single", false], [33, "siblings32", false],
    [40, "single", false], [40, "siblings32", false], [40, "chain32", false],
    [40, "independent16", false], [512, "single", false], [512, "siblings32", false],
    [512, "siblings128", false],
    [40, "single", true], [40, "siblings32", true], [40, "chain32", true],
    [40, "independent16", true], [512, "siblings32", true],
    [40, "siblings128", true],
  ];
  for (const [tabs, shape, flow] of scenarios) {
    for (let repetition = -warmups; repetition < repetitions; repetition++) {
      const rotation = (repetition + warmups) % variants.length;
      const cycle = Math.floor((repetition + warmups) / variants.length) % 2 ? variants.toReversed() : variants;
      const order = [...cycle.slice(rotation), ...cycle.slice(0, rotation)];
      for (const variant of order) {
        const sample = await driver.addon(id, (browser, variant, ids, shape, flow) =>
          window.stackmaBenchmark(variant, ids, shape, flow), variant, pools.get(tabs), shape, flow);
        if (repetition >= 0) report.samples.push({ tabs, shape, flow, repetition, variant, ...sample });
      }
    }
    console.log(`${phase}: ${flow ? "creation" : "admission"} / ${tabs} tabs / ${shape}`);
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(`artifacts/benchmark-${phase}.json`, JSON.stringify(report, null, 2) + "\n");
  if (driver) {
    await driver.close();
    await writeFile(`artifacts/benchmark-${phase}.log`, driver.logs);
  }
  await rm(fixture, { recursive: true, force: true });
}
