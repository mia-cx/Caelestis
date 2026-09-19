# Raid performance measurements

The benchmark uses the complete built userscript on real Wplace in Chromium 150 on macOS.
It opens its own tab, replays 37 claims and 10 peers, and blocks outgoing collaboration mutations.
Every snapshot contains newly parsed copies of the same claim documents.
The browser still renders Wplace and the existing 95-template workload.
Native Wplace activity and machine load introduce variation, so each comparison alternates builds across three pairs.
Bundle hashes, browser context, workloads, frames, long tasks, memory and task/GPU measurements remain in the raw results.

Run a single sample from the repository root:

```sh
RAID_SCENARIOS=hover,movement node scripts/benchmark-wplace-collaboration.mjs \
  /path/to/build.user.js /path/to/result.json 1 --raid
```

Run baseline/candidate, candidate/baseline, then baseline/candidate with the same scenario configuration.
Each hover lasts 30 seconds. Movement uses eight trusted drag/wheel cycles.
Keep the benchmark's persistent focus-emulation CDP session open throughout each sample.
The viewport is emulated at 1440×900 with DPR 1. Browser zoom metadata remains explicitly unknown;
the recorded CSS viewport/DPR and screenshots establish the actual benchmark geometry.

## Unchanged claim documents (#467)

Baseline source is cb7e687 with the presence GPU instrumentation from b936166f.
The candidate adds receivedRegions in presence-client.ts, preserving a document's identity when its serialized content is unchanged.
Metadata still updates, changed geometry replaces the document, and removed IDs leave the retained set.
The focused presence-client test fails before this change and passes afterward (17 tests).

The primary metric is repeated claim rasterization and component CPU during unchanged snapshots.
Both fall to zero after warmup in every candidate run. This also removes repeated mask uploads.
Whole-page CPU improves in all six scenario comparisons. GPU elapsed time does not consistently improve.
This is a CPU/cache improvement; it does not establish a shader improvement or a backend capacity gain.

[Raw comparison profiles](benchmarks/raid-467-2026-09-19.json.gz) include all three pairs and their bundle hashes.

| Scenario | Baseline whole-page CPU, seconds | Candidate whole-page CPU, seconds |
| --- | --- | --- |
| Hover, pair 1 | 18.885 | 13.266 |
| Hover, pair 2 | 18.223 | 8.440 |
| Hover, pair 3 | 14.001 | 12.965 |
| Movement, pair 1 | 3.961 | 3.093 |
| Movement, pair 2 | 3.946 | 2.367 |
| Movement, pair 3 | 4.443 | 3.290 |

The live deletion/recreation fix in PR #463 remains separate. These runs use controlled unchanged snapshots;
they do not attribute the live incident's message rate to normal production behavior.
