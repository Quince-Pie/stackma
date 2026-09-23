import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const report = JSON.parse(await readFile("artifacts/benchmark-confirmation.json", "utf8"));
assert.equal(report.passed, true);
assert.equal(report.phase, "confirmation");
assert.equal(report.samples.length, 15 * 6 * 12, "Every declared comparison must finish");
for (const sample of report.samples) {
  if (sample.flow || !sample.shape.startsWith("siblings")) continue;
  const children = Number(sample.shape.slice("siblings".length));
  const limit = sample.variant === "fifo" ? 1 : sample.variant === "wide-batch" ? 128 : 32;
  const batches = Math.ceil(children / limit);
  assert.equal(sample.calls.group, batches, "Declared sibling workload must match the measured mutations");
  if (["fifo", "batch", "wide-batch", "dependency"].includes(sample.variant)) {
    assert.equal(sample.calls.get, children + batches, "Participant read-count oracle");
  }
}
for (const [file, expected] of Object.entries(report.sources)) {
  assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), expected, `${file} changed after confirmation`);
}
const browser = JSON.parse(await readFile("artifacts/firefox-tests.json", "utf8"));
assert.equal(browser.passed, true);
const names = {
  fifo: "FIFO (1)", batch: "Selected (32)", "wide-batch": "Batch 128",
  query: "Window query", "selective-query": "Query ≥16", dependency: "Dependency",
};
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const key = sample => `${sample.flow ? "Creation" : "Admission"}/${sample.tabs}/${sample.shape}`;
const groups = Map.groupBy(report.samples, key);
const rows = [];
const csv = ["scope,tabs,shape,variant,repetitions,median_ms,min_ms,max_ms,median_cleanup_ms,min_records,max_records,min_get,max_get,min_query,max_query,min_group,max_group"];
for (const [label, samples] of groups) {
  const cells = [];
  for (const variant of report.variants) {
    const selected = samples.filter(sample => sample.variant === variant);
    assert.equal(selected.length, 12, `${label}/${variant} repetitions`);
    const times = selected.map(sample => sample.elapsedMs);
    const lo = Math.min(...times), hi = Math.max(...times), mid = median(times);
    cells.push(`${mid.toFixed(1)} [${lo.toFixed(1)}–${hi.toFixed(1)}]`);
    const counts = ["records", "get", "query", "group"].flatMap(name => [
      Math.min(...selected.map(sample => sample.calls[name])),
      Math.max(...selected.map(sample => sample.calls[name])),
    ]);
    csv.push([...label.split("/"), variant, 12, mid, lo, hi,
      median(selected.map(sample => sample.cleanupMs)), ...counts].join(","));
  }
  rows.push({ label, cells });
}
const table = scope => [
  `| Window tabs / scenario | ${report.variants.map(variant => names[variant]).join(" | ")} |`,
  `| --- | ${report.variants.map(() => "---:").join(" | ")} |`,
  ...rows.filter(row => row.label.startsWith(scope)).map(row =>
    `| ${row.label.split("/").slice(1).join(" / ")} | ${row.cells.join(" | ")} |`),
].join("\n");

const text = `# Firefox 156 comparison evidence

The selected design follows the user's priority: lower retained state and bounded
per-window work. These results do **not** establish universal latency or memory
dominance. Figures are median milliseconds **[observed minimum–maximum]** over 12
measured blocks after two warm-ups. No workload-weighted average, p99 claim,
statistical-equivalence assertion or inferred nonregression margin is used.

Date: ${report.date}. Firefox ${report.browser.version}, build ${report.browser.buildId};
geckodriver ${report.browser.geckodriver}; Node ${report.node}; ${report.cpu};
${report.hardware.architecture}, kernel ${report.hardware.kernel}, ${report.hardware.logicalCpus} logical CPUs.
All variants run sequentially in one disposable, network-isolated profile; variant
order rotates through every position and reverses on alternating cycles. No other
extension was active. This controls several confounders but does not establish
independent samples or eliminate host interference.

## API admission through completion

Tabs already exist at admission. Constructor cost, fresh reads, queueing and
native mutations are timed; tab creation is not. This isolates the mechanism.

${table("Admission")}

## Actual tab creation through handler completion

The timer starts before tabs.create; real onCreated listeners feed the same
controllers. It ends after all admitted relationships finish. Tab creation and
native inheritance are included. The initial window size is shown; creating a
burst increases it. Neither table claims completed UI paint or durable disk flush.

${table("Creation")}

## Work, memory and lifecycle

All candidates satisfied the membership oracle in all ${report.samples.length}
measured samples. [Raw results](../evidence/benchmark-confirmation.json) retain every
sample, operation/record counts, cleanup times, setup times, environment and source
hashes. [CSV summary](../evidence/benchmark-summary.csv) includes all scenarios and
count ranges. Completed relationships per second for a finite burst can be derived
as 1000 × relationship count / elapsed_ms; this is not a sustained-throughput limit.

The ordinary selected batch converts at most 33 participant records per window
read phase. Batch 128 allows 129; a window query returns N, including unrelated
tabs; the dependency scheduler permits multiple components' reads concurrently
and retains endpoint/component membership alongside the same ancestry records.
These are inspected state/work bounds, **not** measured resident-memory megabytes.
Late ancestry traversal is proportional to its affected branch; it is not covered
by the ordinary-batch total-work bound. All variants leave native rendering and
session-store costs in Firefox.

Pool setup took ${report.setup.map(item => `${item.elapsedMs.toFixed(0)} ms for ${item.tabs} tabs`).join("; ")}.
Cleanup is outside the completion timer and is recorded separately for every sample.
The extension performs no startup tab scan, persistent writes or idle polling;
event-page wakeup and native window restore are correctness-tested, not assigned
an unsupported cold-start speed ranking. Twelve samples expose observed maxima,
not reliable extreme-tail distributions.

The exact source-qualified choice, rejected and viable alternatives, accepted API
boundaries and progress argument are in [qualification.md](qualification.md).
The earlier pre-fix confirmation is expressly excluded from these results.

Reproduce with the locked environment:

\`\`\`sh
nix develop
npm ci
npm run check
npm run test:alternatives
npm run test:firefox
npm run benchmark
node scripts/summarize-evidence.js
\`\`\`

Kernel SHA-256: \`${report.kernelSha256}\`.
`;
await mkdir("evidence", { recursive: true });
await writeFile("docs/performance.md", text);
await writeFile("evidence/benchmark-summary.csv", csv.join("\n") + "\n");
await cp("artifacts/benchmark-confirmation.json", "evidence/benchmark-confirmation.json");
await cp("artifacts/firefox-tests.json", "evidence/firefox-tests.json");
await cp("artifacts/firefox-tests-dependency.json", "evidence/firefox-tests-dependency.json");
await cp("artifacts/check.log", "evidence/check.log");
await cp("artifacts/alternatives-test.log", "evidence/alternatives-test.log");
console.log(`Recorded ${report.samples.length} confirmed samples and ${browser.results.length} browser checks.`);
