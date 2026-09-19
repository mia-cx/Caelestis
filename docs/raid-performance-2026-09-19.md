# Raid performance measurements

The benchmark uses the complete built userscript on real Wplace in Chromium 150 on macOS.
It opens its own tab, replays 37 claims and 10 peers, and blocks outgoing collaboration mutations.
Every snapshot contains newly parsed copies of the same claim documents.
The browser still renders Wplace and the existing template workload, whose count and signature must match.
Native Wplace activity and machine load introduce variation, so each comparison alternates builds across three pairs.
Bundle hashes, browser context, workloads, frames, long tasks, memory and task/GPU measurements remain in the raw results.

Run a single sample from the repository root:

```sh
RAID_TEMPLATES=97 RAID_SCENARIOS=hover,movement node scripts/benchmark-wplace-collaboration.mjs \
  /path/to/build.user.js /path/to/result.json 1 --raid
```

Run baseline/candidate, candidate/baseline, then baseline/candidate with the same scenario configuration.
Hover defaults to 30 seconds; `RAID_HOVER_MS=10000` selects the shorter comparison window.
Movement uses eight trusted drag/wheel cycles over 12 seconds.
Keep the benchmark's persistent focus-emulation CDP session open throughout each sample.
The device viewport is emulated at 1440×900 with device scale factor 1. In the first runs, browser zoom was 110%,
giving a 1309×818 CSS viewport and DPR 1.1. The runner records the effective geometry and rejects changes.

## Unchanged claim documents (#467)

Baseline source is cb7e687 with the presence GPU instrumentation from b936166f.
The candidate adds receivedRegions in presence-client.ts, preserving a document's identity when its serialized content is unchanged.
Metadata still updates, changed geometry replaces the document, and removed IDs leave the retained set.
The focused presence-client test fails before this change and passes afterward (17 tests).

The primary metric is repeated claim rasterization and component task time during unchanged snapshots.
Both fall to zero after warmup in every candidate run. This also removes repeated mask uploads.
The final comparison uses three alternating pairs, 97 identical templates, 37 claims and 10 peers,
with a 10-second hover and 12-second movement per build. Movement task time improves in every pair,
by 16.3% on average. Hover frame p95 falls from 33–66.7 ms to 17.4–17.5 ms.
Hover total task time increases in two pairs and decreases in one. GPU time does not consistently improve.
TaskDuration measures elapsed main-thread task time, not operating-system CPU usage.

[Accepted comparison profiles](benchmarks/raid-467-final-2026-09-19.json.gz) contain exact bundle hashes,
effective viewport/DPR, input lateness, template/workload signatures and all frame, GPU and memory data.
Raster plus component task time is 1.47–2.59 seconds per baseline hover and 1.16–1.46 seconds per movement;
all six candidate samples record zero repeated work in those tasks.

| Scenario | Baseline task time, seconds | Candidate task time, seconds |
| --- | --- | --- |
| Hover, pair 1 | 3.653 | 5.252 |
| Hover, pair 2 | 5.973 | 6.093 |
| Hover, pair 3 | 3.757 | 2.874 |
| Movement, pair 1 | 3.906 | 3.128 |
| Movement, pair 2 | 3.629 | 3.360 |
| Movement, pair 3 | 3.919 | 3.101 |

The [initial profiles](benchmarks/raid-467-2026-09-19.json.gz) include one invalid three-template run.
Their earlier percentage claims are withdrawn. The [later 30-second hover profiles](benchmarks/raid-467-verified-2026-09-19.json.gz)
retain the heavy machine-contention diagnostic; they support cache elimination, not a whole-page speedup claim.

The live deletion/recreation fix in PR #463 remains separate. These runs use controlled unchanged snapshots;
they do not attribute the live incident's message rate to normal production behavior.
