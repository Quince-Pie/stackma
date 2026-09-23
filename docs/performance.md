# Firefox 156 comparison evidence

The selected design follows the user's priority: lower retained state and bounded
per-window work. These results do **not** establish universal latency or memory
dominance. Figures are median milliseconds **[observed minimum–maximum]** over 12
measured blocks after two warm-ups. No workload-weighted average, p99 claim,
statistical-equivalence assertion or inferred nonregression margin is used.

Date: 2026-09-23T17:58:18.080Z. Firefox 156.0, build 20260909172920;
geckodriver 0.37.1; Node v24.20.0; AMD Ryzen 9 9950X3D 16-Core Processor;
x64, kernel 6.18.51, 32 logical CPUs.
All variants run sequentially in one disposable, network-isolated profile; variant
order rotates through every position and reverses on alternating cycles. No other
extension was active. This controls several confounders but does not establish
independent samples or eliminate host interference.

## API admission through completion

Tabs already exist at admission. Constructor cost, fresh reads, queueing and
native mutations are timed; tab creation is not. This isolates the mechanism.

| Window tabs / scenario | FIFO (1) | Selected (32) | Batch 128 | Window query | Query ≥16 | Dependency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 / single | 1.4 [0.9–7.7] | 1.2 [0.8–2.7] | 1.3 [0.9–11.8] | 1.6 [0.9–8.9] | 1.5 [0.8–5.8] | 1.9 [0.8–4.5] |
| 33 / siblings32 | 28.1 [22.2–34.9] | 6.2 [4.6–7.5] | 6.5 [4.8–11.0] | 6.0 [4.2–11.2] | 6.5 [4.9–8.3] | 6.9 [5.7–10.3] |
| 40 / single | 0.9 [0.8–4.2] | 1.2 [0.8–1.8] | 1.2 [0.7–4.7] | 1.6 [1.0–4.0] | 1.2 [0.8–5.5] | 1.2 [0.8–1.8] |
| 40 / siblings32 | 31.6 [20.9–89.1] | 7.8 [4.8–13.0] | 8.2 [5.4–9.8] | 7.5 [4.3–13.4] | 8.1 [5.6–17.0] | 8.5 [5.9–17.9] |
| 40 / chain32 | 26.9 [22.6–62.5] | 28.8 [19.0–50.7] | 28.7 [21.1–38.8] | 41.1 [33.8–59.0] | 29.2 [20.0–44.7] | 31.8 [23.2–39.7] |
| 40 / independent16 | 21.9 [19.1–36.6] | 21.4 [17.1–45.1] | 20.7 [18.0–28.8] | 35.2 [22.6–65.9] | 26.2 [16.5–46.3] | 17.9 [11.3–30.0] |
| 512 / single | 3.4 [2.2–10.9] | 2.9 [2.0–3.9] | 3.9 [2.0–5.9] | 8.0 [5.0–38.9] | 2.9 [1.9–4.0] | 3.3 [2.2–3.7] |
| 512 / siblings32 | 198.1 [74.0–415.2] | 20.5 [18.5–44.8] | 20.1 [18.1–22.8] | 24.7 [22.1–31.4] | 25.5 [22.5–39.4] | 21.0 [18.7–28.1] |
| 512 / siblings128 | 783.8 [301.7–1395.6] | 162.9 [149.9–189.9] | 74.3 [70.7–81.3] | 182.0 [170.9–206.3] | 186.8 [166.1–210.3] | 177.5 [151.3–205.7] |

## Actual tab creation through handler completion

The timer starts before tabs.create; real onCreated listeners feed the same
controllers. It ends after all admitted relationships finish. Tab creation and
native inheritance are included. The initial window size is shown; creating a
burst increases it. Neither table claims completed UI paint or durable disk flush.

| Window tabs / scenario | FIFO (1) | Selected (32) | Batch 128 | Window query | Query ≥16 | Dependency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 40 / single | 8.3 [4.9–12.7] | 8.4 [4.7–11.8] | 7.7 [6.4–15.4] | 9.4 [6.9–13.3] | 7.3 [4.7–11.7] | 8.3 [5.7–10.3] |
| 40 / siblings32 | 267.9 [202.7–544.0] | 172.3 [132.4–265.7] | 181.0 [162.1–204.8] | 186.2 [136.1–237.0] | 170.5 [151.5–335.3] | 172.1 [131.3–239.4] |
| 40 / chain32 | 263.9 [194.4–322.5] | 270.6 [193.1–352.5] | 293.0 [224.0–360.1] | 337.7 [223.1–417.0] | 244.2 [175.1–316.7] | 273.8 [181.0–351.5] |
| 40 / independent16 | 102.6 [84.6–125.5] | 107.0 [78.5–135.9] | 107.1 [69.8–209.8] | 110.2 [89.2–224.4] | 99.4 [83.6–123.2] | 88.6 [71.9–107.8] |
| 512 / siblings32 | 1443.3 [1171.3–1837.2] | 1008.3 [906.6–1270.5] | 1041.8 [896.6–1276.0] | 1026.6 [898.5–1080.8] | 1001.1 [778.1–1116.8] | 982.8 [863.0–1095.3] |
| 40 / siblings128 | 1586.5 [1419.1–2258.7] | 960.7 [885.9–1090.5] | 934.4 [836.8–1081.9] | 977.4 [832.7–1203.5] | 965.8 [899.9–1113.9] | 937.7 [766.2–1195.6] |

## Work, memory and lifecycle

All candidates satisfied the membership oracle in all 1080
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

Pool setup took 107 ms for 2 tabs; 252 ms for 33 tabs; 337 ms for 40 tabs; 9610 ms for 512 tabs.
Cleanup is outside the completion timer and is recorded separately for every sample.
The extension performs no startup tab scan, persistent writes or idle polling;
event-page wakeup and native window restore are correctness-tested, not assigned
an unsupported cold-start speed ranking. Twelve samples expose observed maxima,
not reliable extreme-tail distributions.

The exact source-qualified choice, rejected and viable alternatives, accepted API
boundaries and progress argument are in [qualification.md](qualification.md).
The earlier pre-fix confirmation is expressly excluded from these results.

Reproduce with the locked environment:

```sh
nix develop
npm ci
npm run check
npm run test:alternatives
npm run test:firefox
npm run benchmark
node scripts/summarize-evidence.js
```

Kernel SHA-256: `dbc6a88ca320d641799148b0135e868de3a8e78777a54b2d558524b9be46419c`.
