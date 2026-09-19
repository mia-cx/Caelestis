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

## Offscreen preparation (#468)

The baseline includes #467. The candidate rejects hidden claims before preparation and checks actual canvas
visibility before mask rasterization/upload. It retains cheap fade/motion state, so pan entry and exit do not blink.
The primary metric is retained GPU mask memory. All three alternating hover/movement pairs reduce it from
725,200 to 19,600 bytes (97.3%). One of the 37 claims is visible along this camera path.
CPU masks and component labels still retain 725,200 and 1,450,400 bytes respectively; #469 addresses that path.
Whole-page heap values vary with GC. Task and GPU timings do not establish a repeatable speedup.
Frame p95 stays around 17.4–17.6 ms. Screenshots preserve the claim boundary, subtractive hole and hover chips.

The focused culling test covers offscreen-to-visible entry, pan re-entry, hidden changes and mask release after fading.
The affected client tests pass (71 across seven files). [Raw comparison profiles](benchmarks/raid-468-2026-09-19.json.gz)
include exact baseline/candidate bundle hashes and all secondary metrics.

## Lazy hover components (#469)

The baseline includes #468. The candidate checks bounds and occupied pixels before building components.
Cold-hover resets document identities while the pointer is outside the map, then moves onto one claimed piece.
All three pairs build one component map instead of 37. Retained component bytes fall from 1,450,400 to
39,200, and CPU mask bytes from 725,200 to 19,600. Both reductions are 97.3%.

| Pair | Component task time, baseline → candidate | First label, baseline → candidate |
| --- | --- | --- |
| 1 | 137.6 → 3.3 ms | 191.9 → 16.1 ms |
| 2 | 40.7 → 7.4 ms | 70.1 → 55.3 ms |
| 3 | 35.7 → 8.0 ms | 69.8 → 49.0 ms |

The lower component cost and first-label latency repeat in every pair. Whole-page task time does not:
it improves in one cold-hover pair and increases in two. Warm movement and idle timings show no consistent gain.
The focused test covers outside bounds, gaps, subtraction holes, separate pieces, changed geometry and deletion.
[Raw profiles](benchmarks/raid-469-2026-09-19.json.gz) retain all three scenarios and exact build hashes.

## Coalesced presence notifications (#471)

The baseline includes #469. The candidate schedules the next map frame instead of immediately rerunning
every screen hook for each presence message. The primary metric is synchronous presence notification task time.
It falls in all three hover pairs (56.6/55.2/65.4 to 10.9/27.7/26.8 ms), and all movement pairs
(51.3/42.8/41.8 to 10.9/9.4/8.5 ms). Label passes match rendered frames instead of frames plus messages.
This removes duplicate work; it does not delay applying incoming state.

Whole-page task time and total label time do not consistently improve. Two candidate hover runs take twice
as much task time across unrelated tasks as their baselines. Frame p95 remains 17.3–17.6 ms.
The burst test verifies five notifications request rendering without synchronously repainting controls,
then refresh controls once on the next frame. The affected focused suite passes 49 tests.
[Raw profiles](benchmarks/raid-471-2026-09-19.json.gz) include hover, trusted movement and idle recovery.

## Shared scene preparation (#472)

The baseline includes #471. Overlay, outline and marker layers share one prepared scene per captured world frame.
The captured quad array identifies the frame; other hosts retain their independent scene and timing.
The primary metric sums the three rendering tasks, including their common scene preparation.

| Pair | Movement render tasks, baseline → candidate | Idle render tasks, baseline → candidate |
| --- | --- | --- |
| 1 | 695.3 → 395.4 ms | 639.6 → 391.4 ms |
| 2 | 687.7 → 377.7 ms | 638.5 → 373.2 ms |
| 3 | 682.4 → 378.2 ms | 633.8 → 379.5 ms |

Movement render time falls 44.3% on average; idle falls 40.1%. Whole-page movement task time falls
from 3.238/3.207/3.157 to 3.119/3.108/3.081 seconds, a 3.1% mean improvement in all three pairs.
Hover whole-page and rendering costs remain inconsistent. All samples have zero observed long tasks,
and frame p95 remains 17.2–17.6 ms. Tests preserve next-frame fades, template replacement and host separation.
[Raw profiles](benchmarks/raid-472-2026-09-19.json.gz) record the full workload and exact bundle hashes.

## Shared label geometry (#473)

Labels reuse the map projection's canvas bounds. The cache invalidates on scroll, resize, font loading,
canvas replacement and ancestor layout changes. It ignores per-frame writes to label children.
The baseline includes #472; the candidate includes these invalidation checks.

Movement label task time falls from 309.2/310.1/330.2 to 146.6/147.5/142.9 ms across three alternating pairs,
a 54.4% mean reduction. Idle falls from 186.0/160.3/170.9 to 101.2/90.7/96.5 ms.
Movement layout and style time improve in each pair, but whole-page task time does not consistently improve.
Frame p95 remains 17.2–17.5 ms. Focused tests cover ancestor movement, sibling insertion, label writes,
projection replacement and label placement. All 25 tests pass, as does the userscript typecheck.
[Raw profiles](benchmarks/raid-473-2026-09-20.json.gz) retain the noisy hover runs and exact build hashes.

## Transparent fragments (#470)

The baseline includes #473. The candidate discards only fragments whose final alpha is exactly zero,
after border and pattern evaluation. Premultiplied blending previously wrote a zero contribution at those pixels.
Colours, opacity, masks, borders and visible patterns retain the same computation.
The primary metric is presence GPU elapsed time per rendered movement frame.

| Pair | Combined layers, baseline → candidate | Viewports only, baseline → candidate |
| --- | --- | --- |
| 1 | 1.217 → 1.104 ms | 0.897 → 0.746 ms |
| 2 | 1.312 → 1.186 ms | 0.864 → 0.775 ms |
| 3 | 1.322 → 1.133 ms | 0.870 → 0.697 ms |

Combined movement improves 11.1%, with separate baseline/candidate ranges. Viewports improve in every movement
and idle pair. Hover results vary. Claims-only rendering at zoom 12 shows no repeatable improvement; those
measurements include all 37 claims at a smaller scale. No mask sampling, draw calls or uploads are removed.
Whole-page task time does not establish a general speedup. Matching hover screenshots preserve coverage,
subtractive holes, border thickness and labels. These measurements use the available Mac GPU only.

[Combined profiles](benchmarks/raid-470-combined-2026-09-20.json.gz),
[viewport profiles](benchmarks/raid-470-viewports-2026-09-20.json.gz) and
[claims-only zoom 12 profiles](benchmarks/raid-470-claims-2026-09-20.json.gz)
retain all three alternating pairs, build hashes, draw counts, mask bytes and frame measurements.
