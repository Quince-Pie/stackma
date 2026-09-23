import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const samples = await read('evidence/naming-benchmark-confirmation.json');
const cache = await read('evidence/naming-cache-confirmation.json');
assert(samples.passed && cache.passed);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const combined = createHash('sha256');
const files = {};
for (const file of (await readdir('extension')).sort()) {
  const bytes = await readFile(`extension/${file}`);
  files[file] = hash(bytes);
  combined.update(file).update(bytes);
  assert.equal(samples.sourceSha256[file], files[file], `Outdated final selector evidence: ${file}`);
  assert.equal(cache.sourceSha256[file], files[file], `Outdated final cache evidence: ${file}`);
}
const sourceSha256 = combined.digest('hex');
const stats = values => {
  const a = values.toSorted((x, y) => x - y);
  return { median: (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2,
    min: a[0], max: a.at(-1), p95: a[Math.ceil(a.length * .95) - 1] };
};
const fixed = value => value.toFixed(2);
const span = s => `${fixed(s.median)} [${fixed(s.min)}–${fixed(s.max)}]`;
const variants = ['two-pass', 'array', 'typed-array', 'reservoir', 'reservoir-buffered', 'rejection-8'];
let text = `# Naming performance and selection\n\n`;
text += `Final source aggregate SHA-256: \`${sourceSha256}\`. Per-file hashes are in [the evidence manifest](../evidence/naming-manifest.json).\n\n`;
text += `Firefox ${samples.browser.version}, build ${samples.browser.buildId}; geckodriver ${samples.browser.geckodriver}; ${samples.hardware.cpu}; ${samples.hardware.logicalCpus} logical CPUs, ${fixed(samples.hardware.ramBytes / 2 ** 30)} GiB RAM; Linux ${samples.hardware.kernel}; Node ${samples.toolchain.node}.\n\n`;
text += `These are labelled scenarios, with no invented workload frequencies or weights. Six selectors share the same catalog, preprocessing, reuse tiers, range mapping and fallback; only final selection differs. Each scenario has two warm-up blocks and 12 fixed confirmation blocks in seeded shuffled order. Each kernel block performs 64 complete selections including normalization, allocations and randomness, with consumed outputs. Native samples create real related tabs and include grouping, constructors, identity validation, session history and title APIs. Setup, reset and cleanup costs remain in the raw reports.\n\n`;
text += `Both coordinators use the delivered identity guard. No measurement sessions ran concurrently. Native timers requested privacy.reduceTimerPrecision=false. CPU affinity, clock frequency and unrelated system load were not fixed. First-use import observations share an already initialized catalog/production module and are not comparable cold-browser startup timings. Counts/payload bounds are not heap/RSS measurements.\n\n`;
text += `Selection follows the existing priority for lower retained state and bounded work. No latency equivalence margin or workload weighting was supplied, so none is invented. Results are descriptive medians/ranges, not confidence intervals, hypothesis-test wins or simultaneous dominance. Microbench selection data were exploratory; the tables below use fresh fixed confirmation after the selected singleton fast path and native-ID guards. An eligible set of size one requires neither a random draw nor another scan.\n\n`;
text += `## Complete selector cost\n\nMicroseconds per selection; median of 12 block means. Raw block dispersion is retained in JSON; block means do not estimate individual-operation p99 latency.\n\n`;
text += `| Context | ${variants.join(' | ')} |\n| --- | ${variants.map(() => '---:').join(' | ')} |\n`;
const summary = [];
for (const scenario of samples.scenarios) {
  text += `| ${scenario.name} (${scenario.titleCount} titles; ${scenario.eligible} best-tier edges) | `;
  text += variants.map(variant => {
    const s = stats(samples.samples.filter(row => row.variant === variant && row.scenario === scenario.name).map(row => row.elapsedMs * 1000 / samples.iterations));
    summary.push({ scope: 'selector-us', scenario: scenario.name, variant, ...s });
    return fixed(s.median);
  }).join(' | ') + ' |\n';
}
text += `\nTwo-pass selection retains no eligible-offset array and uses at most one 64-bit draw. A typed offset array uses up to 1,716 additional payload bytes; a best-tier bitmap could reduce that extra candidate payload to 108 bytes, but still adds candidate state and does not remove context reads. Reservoir has constant candidate state but may consume hundreds of draws; the 256-byte buffered variant fairly reduces crypto calls. Bounded rejection is credible for dense tiers and can be faster locally, but may use nine draws and a full fallback scan. The chosen bounded-work rule prefers one draw and no candidate array; this is not a claim of minimum elapsed time in every case. Skip-based reservoir variants do not remove the need to discover the final reuse tier; once its count is known, one rank draw already selects the needed eligible ordinal.\n\n`;
text += `## Real creation through native name assignment\n\nMilliseconds for complete batches: median [minimum–maximum], 12 samples per cell. These include API completion, not paint or human perception.\n\n| Existing groups / new families | ${variants.join(' | ')} |\n| --- | ${variants.map(() => '---:').join(' | ')} |\n`;
for (const contextGroups of [0, 128]) for (const families of [1, 16]) {
  text += `| ${contextGroups} / ${families} | ` + variants.map(variant => {
    const rows = samples.nativeSamples.filter(row => row.variant === variant && row.contextGroups === contextGroups && row.families === families);
    const s = stats(rows.map(row => row.elapsedMs));
    const latency = stats(rows.flatMap(row => row.latencies));
    summary.push({ scope: 'native-ms', scenario: `${contextGroups}/${families}`, variant, ...s, eventP95: latency.p95,
      cleanupMedian: stats(rows.map(row => row.cleanupMs)).median, resetMedian: stats(rows.map(row => row.resetMs)).median });
    return span(s);
  }).join(' | ') + ' |\n';
}
text += `\nAPI/native work dominates the inexpensive selectors. Grouping new tabs, querying native context, serial title writes, and Firefox rendering work outside these completion timers prevent a small kernel difference from proving an end-to-end win. These finite-burst completion rates are not sustained open-loop throughput. Individual event-latency p95 values and cleanup/reset medians are in the summary JSON; events within a burst are dependent and those empirical percentiles are not independently sampled tail guarantees. Cleanup timings cover fixture ungroup/removal, not every background-event cleanup cost over a sustained extension lifetime.\n\n`;
text += `## Transient context-cache challenge\n\nThe repaired contender preserves colliding titles and shares the identity guard. Both versions use the same selected two-pass generator and zero context at idle. “Index rows” counts coordinator-retained native metadata, not physical peak heap.\n\n| Existing groups / families | Fresh context ms | Burst context ms | Native context queries, fresh / burst (median) | Burst peak retained rows |\n| --- | ---: | ---: | ---: | ---: |\n`;
for (const contextGroups of [0, 128]) for (const families of [1, 16]) {
  const rows = variant => cache.nativeSamples.filter(row => row.variant === variant && row.contextGroups === contextGroups && row.families === families);
  const fresh = rows('fresh-context'), burst = rows('burst-context');
  text += `| ${contextGroups} / ${families} | ${span(stats(fresh.map(row => row.elapsedMs)))} | ${span(stats(burst.map(row => row.elapsedMs)))} | ${stats(fresh.map(row => row.calls['tabGroups.query'])).median} / ${stats(burst.map(row => row.calls['tabGroups.query'])).median} | ${Math.max(...burst.map(row => row.peakIndexRecords))} |\n`;
  for (const [variant, values] of [['fresh-context', fresh], ['burst-context', burst]]) {
    assert(values.every(row => row.idleIndexRecords === 0));
    summary.push({ scope: 'cache-native-ms', scenario: `${contextGroups}/${families}`, variant, ...stats(values.map(row => row.elapsedMs)),
      contextQueries: stats(values.map(row => row.calls['tabGroups.query'])).median,
      retainedRows: Math.max(...values.map(row => row.peakIndexRecords)) });
  }
}
text += `\nThe cache reduces context queries during bursts and has favorable latency observations in some scenarios. Fresh per-assignment context is delivered because it maintains no native-name index between jobs and needs fewer synchronization invariants, following the user's state priority. No claim is made that its peak heap or every latency tail is lower. Native-ID ambiguity detection is a separate safety necessity and stores only ambiguous IDs, normally an empty Set.\n\n`;
text += `## Reproduce and interpret\n\n\`nix develop --command node scripts/naming-benchmark.js --confirmation\`\n\n\`nix develop --command node scripts/naming-benchmark.js --cache-comparison --confirmation\`\n\n\`nix develop --command node scripts/summarize-naming.js\`\n\nRaw final evidence: [selectors/native](../evidence/naming-benchmark-confirmation.json), [cache/native](../evidence/naming-cache-confirmation.json), [summary](../evidence/naming-summary.json). The 504 selector blocks, 288 selector/native batches and 96 cache/native batches all passed their oracles on the final guarded sources. No caller may overwrite a failed report and call the repeat the original confirmation. The preserved earlier uninstrumented cache failure remains unattributed; earlier pre-guard/collapsing-cache runs are superseded for final-artifact claims, not erased. See [qualification](naming-qualification.md) for the evaluator repair, native-ID proof and the separate uncompleted human qualification.\n`;
await writeFile('docs/naming-performance.md', text);
await writeFile('evidence/naming-summary.json', JSON.stringify(summary, null, 2) + '\n');
await writeFile('evidence/naming-manifest.json', JSON.stringify({ sourceSha256, files, finalSelectorSourceHashes: samples.sourceSha256,
  finalCacheSourceHashes: cache.sourceSha256, executedHarnessSha256: hash(await readFile('evidence/naming-harness-confirmation.js')),
  executedCandidateBuilderSha256: hash(await readFile('evidence/naming-candidates-confirmation.js')),
  date: new Date().toISOString() }, null, 2) + '\n');
console.log(`Summarized final guarded source ${sourceSha256}`);
