# Naming performance and selection

Final source aggregate SHA-256: `5bd6d065dd82eb48251ca96820d37ce8a528fd090ee8c3ba83be77ef09b46dc1`. Per-file hashes are in [the evidence manifest](../evidence/naming-manifest.json).

Firefox 156.0, build 20260909172920; geckodriver 0.37.1; AMD Ryzen 9 9950X3D 16-Core Processor; 32 logical CPUs, 91.84 GiB RAM; Linux 6.18.51; Node v24.20.0.

These are labelled scenarios, with no invented workload frequencies or weights. Six selectors share the same catalog, preprocessing, reuse tiers, range mapping and fallback; only final selection differs. Each scenario has two warm-up blocks and 12 fixed confirmation blocks in seeded shuffled order. Each kernel block performs 64 complete selections including normalization, allocations and randomness, with consumed outputs. Native samples create real related tabs and include grouping, constructors, identity validation, session history and title APIs. Setup, reset and cleanup costs remain in the raw reports.

Both coordinators use the delivered identity guard. No measurement sessions ran concurrently. Native timers requested privacy.reduceTimerPrecision=false. CPU affinity, clock frequency and unrelated system load were not fixed. First-use import observations share an already initialized catalog/production module and are not comparable cold-browser startup timings. Counts/payload bounds are not heap/RSS measurements.

Selection follows the existing priority for lower retained state and bounded work. No latency equivalence margin or workload weighting was supplied, so none is invented. Results are descriptive medians/ranges, not confidence intervals, hypothesis-test wins or simultaneous dominance. Microbench selection data were exploratory; the tables below use fresh fixed confirmation after the selected singleton fast path and native-ID guards. An eligible set of size one requires neither a random draw nor another scan.

## Complete selector cost

Microseconds per selection; median of 12 block means. Raw block dispersion is retained in JSON; block means do not estimate individual-operation p99 latency.

| Context | two-pass | array | typed-array | reservoir | reservoir-buffered | rejection-8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| empty (0 titles; 858 best-tier edges) | 6.41 | 7.66 | 5.00 | 484.22 | 86.56 | 4.84 |
| 32-known (32 titles; 170 best-tier edges) | 22.97 | 22.50 | 21.25 | 143.28 | 39.06 | 21.41 |
| 256-known (256 titles; 1 best-tier edges) | 136.72 | 129.06 | 134.53 | 143.28 | 136.41 | 132.81 |
| 128-manual (128 titles; 858 best-tier edges) | 196.25 | 197.66 | 192.97 | 707.66 | 273.13 | 196.41 |
| exhausted (858 titles; 0 best-tier edges) | 480.78 | 472.19 | 482.03 | 465.47 | 487.81 | 482.97 |
| single-best-edge (669 titles; 1 best-tier edges) | 365.00 | 402.19 | 337.50 | 366.41 | 346.25 | 340.16 |
| sparse-best-tier (263 titles; 12 best-tier edges) | 133.59 | 133.28 | 130.16 | 137.19 | 138.13 | 137.50 |

Two-pass selection retains no eligible-offset array and uses at most one 64-bit draw. A typed offset array uses up to 1,716 additional payload bytes; a best-tier bitmap could reduce that extra candidate payload to 108 bytes, but still adds candidate state and does not remove context reads. Reservoir has constant candidate state but may consume hundreds of draws; the 256-byte buffered variant fairly reduces crypto calls. Bounded rejection is credible for dense tiers and can be faster locally, but may use nine draws and a full fallback scan. The chosen bounded-work rule prefers one draw and no candidate array; this is not a claim of minimum elapsed time in every case. Skip-based reservoir variants do not remove the need to discover the final reuse tier; once its count is known, one rank draw already selects the needed eligible ordinal.

## Real creation through native name assignment

Milliseconds for complete batches: median [minimum–maximum], 12 samples per cell. These include API completion, not paint or human perception.

| Existing groups / new families | two-pass | array | typed-array | reservoir | reservoir-buffered | rejection-8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 / 1 | 7.90 [5.20–12.06] | 8.40 [5.48–10.96] | 7.45 [4.32–11.04] | 9.77 [7.72–16.10] | 7.85 [4.74–11.16] | 7.92 [4.36–10.94] |
| 0 / 16 | 94.81 [81.20–196.82] | 110.51 [86.56–136.66] | 113.54 [78.52–183.36] | 126.20 [93.66–187.08] | 104.31 [88.52–147.28] | 114.50 [73.80–200.82] |
| 128 / 1 | 25.63 [19.78–68.42] | 29.73 [20.12–68.52] | 28.73 [20.64–55.02] | 38.82 [17.26–58.62] | 25.60 [21.76–61.18] | 29.68 [22.70–73.42] |
| 128 / 16 | 481.46 [366.90–657.84] | 521.66 [408.16–687.70] | 515.04 [459.46–601.40] | 483.91 [360.34–594.52] | 511.54 [390.28–606.62] | 520.78 [401.94–662.00] |

API/native work dominates the inexpensive selectors. Grouping new tabs, querying native context, serial title writes, and Firefox rendering work outside these completion timers prevent a small kernel difference from proving an end-to-end win. These finite-burst completion rates are not sustained open-loop throughput. Individual event-latency p95 values and cleanup/reset medians are in the summary JSON; events within a burst are dependent and those empirical percentiles are not independently sampled tail guarantees. Cleanup timings cover fixture ungroup/removal, not every background-event cleanup cost over a sustained extension lifetime.

## Transient context-cache challenge

The repaired contender preserves colliding titles and shares the identity guard. Both versions use the same selected two-pass generator and zero context at idle. “Index rows” counts coordinator-retained native metadata, not physical peak heap.

| Existing groups / families | Fresh context ms | Burst context ms | Native context queries, fresh / burst (median) | Burst peak retained rows |
| --- | ---: | ---: | ---: | ---: |
| 0 / 1 | 6.56 [4.20–98.80] | 6.25 [4.86–10.44] | 1 / 1 | 1 |
| 0 / 16 | 109.46 [73.42–164.28] | 96.37 [66.34–136.66] | 16 / 7 | 16 |
| 128 / 1 | 25.21 [21.04–63.44] | 29.79 [20.84–63.42] | 1 / 1 | 129 |
| 128 / 16 | 485.55 [400.90–624.60] | 468.52 [390.92–600.66] | 16 / 7 | 144 |

The cache reduces context queries during bursts and has favorable latency observations in some scenarios. Fresh per-assignment context is delivered because it maintains no native-name index between jobs and needs fewer synchronization invariants, following the user's state priority. No claim is made that its peak heap or every latency tail is lower. Native-ID ambiguity detection is a separate safety necessity and stores only ambiguous IDs, normally an empty Set.

## Reproduce and interpret

`nix develop --command node scripts/naming-benchmark.js --confirmation`

`nix develop --command node scripts/naming-benchmark.js --cache-comparison --confirmation`

`nix develop --command node scripts/summarize-naming.js`

Raw final evidence: [selectors/native](../evidence/naming-benchmark-confirmation.json), [cache/native](../evidence/naming-cache-confirmation.json), [summary](../evidence/naming-summary.json). The 504 selector blocks, 288 selector/native batches and 96 cache/native batches all passed their oracles on the final guarded sources. No caller may overwrite a failed report and call the repeat the original confirmation. The preserved earlier uninstrumented cache failure remains unattributed; earlier pre-guard/collapsing-cache runs are superseded for final-artifact claims, not erased. See [qualification](naming-qualification.md) for the evaluator repair, native-ID proof and the separate uncompleted human qualification.
