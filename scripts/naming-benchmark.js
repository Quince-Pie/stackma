import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, arch, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { namingCandidates } from '../experiments/naming-candidates.js';
import { chooseName } from '../extension/name-generator.js';
import { FirefoxDriver } from './webdriver.js';

const phase = process.argv.includes('--confirmation') ? 'confirmation' : 'exploratory';
const repetitions = phase === 'confirmation' ? 12 : 3;
const warmups = phase === 'confirmation' ? 2 : 1;
const iterations = 64;
const cacheComparison = process.argv.includes('--cache-comparison');
const candidates = await namingCandidates();
const sources = cacheComparison
  ? { 'fresh-context': candidates['two-pass'], 'burst-context': candidates['two-pass'] }
  : candidates;
const variants = Object.keys(sources);
const pack = JSON.parse(await readFile('naming-data/en-v1.json', 'utf8'));
const names = pack.pairs.map(pair => `${pair.adjective}-${pair.noun}`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const scenarios = [
  ['empty', []],
  ['32-known', Array.from({ length: 32 }, (_, i) => names[i * 23 % names.length])],
  ['256-known', Array.from({ length: 256 }, (_, i) => names[i * 17 % names.length])],
  ['128-manual', Array.from({ length: 128 }, (_, i) => `user${i}-group${i}`)],
  ['exhausted', names],
];
let single, sparse;
for (let i = 1; i < names.length && (!single || !sparse); i++) {
  const context = names.slice(0, i);
  const { eligible } = chooseName(context, () => 0n);
  if (eligible === 1 && !single) single = ['single-best-edge', context];
  if (eligible >= 2 && eligible <= 12 && !sparse) sparse = ['sparse-best-tier', context];
}
assert(single && sparse, 'Required challenger-favorable cases must exist');
scenarios.push(single, sparse);
const fixture = await mkdtemp(join(tmpdir(), 'stackma-naming-bench-'));
const report = {
  phase, cacheComparison, repetitions, warmups, iterations, startedAt: new Date().toISOString(),
  toolchain: { node: process.version },
  hardware: { cpu: cpus()[0].model, architecture: arch(), kernel: release(), logicalCpus: cpus().length, ramBytes: totalmem() },
  sourceSha256: {}, scenarios: scenarios.map(([name, titles]) => ({ name, titleCount: titles.length, eligible: chooseName(titles, () => 0n).eligible })),
  samples: [], nativeSamples: [], setup: [],
  policy: 'Fixed blocks and seeded shuffled candidate order; full chooseName includes preprocessing, RNG and allocation. Native creation-to-name completion includes constructors and APIs; setup/teardown reported separately. No paint, human outcome or statistical dominance claim.',
};
let driver;
let orderSeed = phase === 'confirmation' ? 0x51e2ac97 : 0x17cc8381;
function order() {
  const result = [...variants];
  for (let i = result.length - 1; i > 0; i--) {
    orderSeed ^= orderSeed << 13; orderSeed ^= orderSeed >>> 17; orderSeed ^= orderSeed << 5;
    const j = (orderSeed >>> 0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
try {
  await cp('extension', fixture, { recursive: true });
  const burstSource = (await readFile('experiments/burst-namer.js', 'utf8')).replace('"../extension/name-generator.js"', '"./name-generator.js"');
  await writeFile(join(fixture, 'burst-namer.js'), burstSource);
  report.sourceSha256['burst-namer.js'] = digest(burstSource);
  for (const file of await readdir('extension')) report.sourceSha256[file] = digest(await readFile(`extension/${file}`));
  for (const [variant, code] of Object.entries(sources)) {
    await writeFile(join(fixture, `candidate-${variant}.js`), code);
    report.sourceSha256[`candidate-${variant}.js`] = digest(code);
  }
  const manifest = JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8'));
  manifest.name = 'Stackma isolated naming benchmark';
  manifest.browser_specific_settings.gecko.id = 'stackma-naming-benchmark@extensions.local';
  manifest.background.scripts = ['naming-bench-bg.js'];
  await writeFile(join(fixture, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(fixture, 'naming-bench-bg.js'), `
import { createStacker } from './stacker.js';
import { createNamer } from './namer.js';
import { createNamer as createBurstNamer } from './burst-namer.js';
import { createGroupIdGuard } from './group-id-guard.js';
let current;
const modules = new Map();
globalThis.nameBenchLoad = async variants => {
  const result = [];
  for (const variant of variants) {
    const start = performance.now();
    modules.set(variant, await import('./candidate-' + variant + '.js'));
    const first = modules.get(variant).chooseName([]);
    result.push({ variant, moduleAndFirstUseMs: performance.now() - start, first });
  }
  return result;
};
globalThis.nameBenchKernel = (variant, titles, iterations) => {
  const choose = modules.get(variant).chooseName;
  let checksum = 0, eligible, fallback = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const result = choose(titles);
    checksum += result.name.length + result.name.charCodeAt(0);
    eligible = result.eligible; fallback += Number(result.kind === 'numbered');
  }
  return { elapsedMs: performance.now() - start, checksum, eligible, fallback };
};
function receive(tab) {
  if (!current || !Number.isInteger(tab.openerTabId)) return;
  const owner = current;
  const start = performance.now();
  return owner.stacker.enqueue({ tabId: tab.id, sourceTabId: tab.openerTabId, windowId: tab.windowId })
    .then(() => owner.latencies.push(performance.now() - start));
}
browser.tabs.onCreated.addListener(receive);
browser.tabs.onRemoved.addListener(id => current?.stacker.forget(id));
browser.tabGroups.onUpdated.addListener(group => current?.namer.updated(group));
browser.tabGroups.onRemoved.addListener(group => { current?.guard.invalidate(); current?.namer.removed(group); });
browser.tabGroups.onMoved.addListener(group => { current?.guard.invalidate(); current?.namer.moved(group); });
browser.tabGroups.onCreated.addListener(group => { current?.guard.invalidate(); current?.namer.created?.(group); });
browser.windows.onCreated.addListener(window => { current?.guard.invalidate(); current?.namer.windowCreated?.(window); });
browser.windows.onRemoved.addListener(id => { current?.guard.invalidate(); return current?.namer.closedWindow(id); });
globalThis.nameBenchNative = async (variant, parents, windowId) => {
  const calls = {}, errors = [], latencies = [];
  let peakIndexRecords = 0;
  function instrument(namespace, names) {
    return Object.fromEntries(names.map(name => [name, async (...args) => {
      const key = namespace + '.' + name;
      calls[key] = (calls[key] ?? 0) + 1;
      const result = await (namespace === 'session' ? browser.storage.session[name](...args) : browser[namespace][name](...args));
      peakIndexRecords = Math.max(peakIndexRecords, current?.namer.diagnostics?.().cachedGroups ?? 0);
      return result;
    }]));
  }
  const api = {
    tabs: instrument('tabs', ['get','query','group','move']),
    tabGroups: instrument('tabGroups', ['get','query','update']),
    windows: instrument('windows', ['getAll']),
    storage: { session: instrument('session', ['get','set','remove']) },
  };
  const resetStart = performance.now();
  await browser.storage.session.clear();
  const resetMs = performance.now() - resetStart;
  const start = performance.now();
  const onError = error => errors.push(String(error));
  const guard = createGroupIdGuard(api);
  const factory = variant === 'burst-context' ? createBurstNamer : createNamer;
  const namer = factory({ ...api, tabGroups: { ...api.tabGroups, query: guard.query } }, { choose: modules.get(variant).chooseName, onError });
  const stacker = createStacker(api, { onError, onGroupCreated: namer.enqueue, validateGroupIds: guard.validate });
  current = { stacker, namer, guard, latencies };
  const children = await Promise.all(parents.map(openerTabId => browser.tabs.create({ windowId, openerTabId, active: false })));
  await stacker.idle(); await namer.idle();
  const elapsedMs = performance.now() - start;
  if (errors.length) throw new Error(errors.join('; '));
  const titles = [], ids = [];
  for (let i = 0; i < parents.length; i++) {
    const [parent, child] = await Promise.all([browser.tabs.get(parents[i]), browser.tabs.get(children[i].id)]);
    if (parent.groupId < 0 || parent.groupId !== child.groupId) throw new Error('Membership oracle failed');
    const group = await browser.tabGroups.get(parent.groupId);
    if (!group.title) throw new Error('Native naming oracle failed');
    titles.push(group.title); ids.push(group.id);
  }
  if (new Set(titles).size !== parents.length || new Set(ids).size !== parents.length) {
    throw new Error('Unique family oracle failed: ' + JSON.stringify({ variant, parents, children: children.map(tab => tab.id), ids, titles, calls }));
  }
  const cleanupStart = performance.now();
  current = null;
  await browser.tabs.ungroup([...parents, ...children.map(tab => tab.id)]);
  await browser.tabs.remove(children.map(tab => tab.id));
  return { elapsedMs, resetMs, cleanupMs: performance.now() - cleanupStart, latencies, calls, titles, peakIndexRecords,
    idleIndexRecords: namer.diagnostics?.().cachedGroups ?? 0 };
};
`);
  driver = await FirefoxDriver.start({ timeoutMs: 60_000, maxLifetimeMs: 600_000, prefs: { 'privacy.reduceTimerPrecision': false } });
  const id = await driver.installAddon(fixture);
  report.browser = { version: driver.capabilities.browserVersion, buildId: driver.capabilities['moz:buildID'], geckodriver: driver.capabilities['moz:geckodriverVersion'] };
  const extra = await driver.chrome(async id => {
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    return (await AddonManager.getAddonsByTypes(['extension'])).filter(a => a.isActive && !a.isSystem && !a.isBuiltin && a.id !== id).map(a => a.id);
  }, id);
  assert.deepEqual(extra, []);
  report.moduleUse = await driver.addon(id, (browser, variants) => window.nameBenchLoad(variants), variants);
  for (const [scenario, titles] of cacheComparison ? [] : scenarios) {
    for (let block = -warmups; block < repetitions; block++) {
      for (const variant of order()) {
        const result = await driver.addon(id, (browser, variant, titles, iterations) => window.nameBenchKernel(variant, titles, iterations), variant, titles, iterations);
        assert(result.checksum > 0);
        if (block >= 0) report.samples.push({ scenario, variant, block, ...result });
      }
    }
    console.log(`${phase}: full selector / ${scenario}`);
  }
  for (const contextGroups of [0, 128]) {
    const setupStart = performance.now();
    const pool = await driver.addon(id, async (browser, contextGroups, names) => {
      const win = await browser.windows.create({ focused: true });
      const parents = [win.tabs[0].id];
      for (let i = 1; i < 16; i++) parents.push((await browser.tabs.create({ windowId: win.id, active: false })).id);
      for (let i = 0; i < contextGroups; i++) {
        const tab = await browser.tabs.create({ windowId: win.id, active: false });
        const group = await browser.tabs.group({ tabIds: [tab.id], createProperties: { windowId: win.id } });
        await browser.tabGroups.update(group, { title: names[i * 17 % names.length] });
      }
      return { windowId: win.id, parents };
    }, contextGroups, names);
    report.setup.push({ contextGroups, elapsedMs: performance.now() - setupStart });
    for (const families of [1, 16]) {
      for (let block = -warmups; block < repetitions; block++) {
        for (const variant of order()) {
          report.inFlight = { contextGroups, families, block, variant };
          const result = await driver.addon(id, (browser, variant, parents, windowId) => window.nameBenchNative(variant, parents, windowId), variant, pool.parents.slice(0, families), pool.windowId);
          assert.equal(result.latencies.length, families);
          for (const title of result.titles) assert(names.includes(title) || /^stack-[1-9][0-9]*$/.test(title));
          if (block >= 0) report.nativeSamples.push({ contextGroups, families, block, variant, ...result });
          delete report.inFlight;
        }
      }
      console.log(`${phase}: native names / ${contextGroups} existing groups / ${families} families`);
    }
    await driver.addon(id, (browser, windowId) => browser.windows.remove(windowId), pool.windowId);
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = String(error); throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir('evidence', { recursive: true });
  await writeFile(`evidence/naming-${cacheComparison ? 'cache' : 'benchmark'}-${phase}.json`, JSON.stringify(report, null, 2) + '\n');
  await driver?.close();
  await rm(fixture, { recursive: true, force: true });
}
