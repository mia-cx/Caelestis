# Raid performance after claim grouping and deletion

These comparisons use main c2121c03, including the merged claim-grouping and deletion changes.
The submitted branch is rebased onto main 05088c8e; measurements retain their original source and bundle identities.
Each retained optimization has three alternating baseline/candidate pairs. Individual percentages are not additive.
The earlier [browser](raid-performance-2026-09-19.md) and
[backend](raid-backend-performance-2026-09-20.md) reports describe the preceding cb7e687 implementation.

## Built userscript on Wplace

Chromium 150 runs the complete built userscript on real Wplace, with a persistent focus-emulation CDP session.
The isolated replay contains 97 templates, 37 claims with subtraction holes, and ten moving peers.
Fresh claim snapshots arrive every 300 ms. The runner blocks external collaboration writes and owns its temporary tab.
Each comparison checks template, workload, browser, camera and viewport signatures, plus bundle hashes.
Movement follows eight trusted drag/wheel cycles over 12 seconds. Individual comparisons hold hover for ten seconds;
the historical combined comparison holds it for 30 seconds. TaskDuration is elapsed main-thread task time, not operating-system CPU.

| Change | Matched result | Limits |
| --- | --- | --- |
| Retain unchanged claims and geometry (#467) | Movement task time falls 9.5%, from 2.947/2.753/2.983 to 2.660/2.555/2.640 seconds. | Hover and idle vary; frame p95 stays around 17.6 ms. |
| Skip offscreen GPU masks (#468) | Retained GPU mask bytes fall from 725,200 to 19,600 in every sample, a 97.3% reduction. | Whole-page task time varies. CPU claim masks remain 725,200 bytes because complete display unions still need their members. |
| Delay components until an occupied pixel (#469) | Hovering a subtraction hole retains zero component-label bytes, versus 39,200 in all three baselines. | Normal claimed hover needs the same 39,200 bytes. Whole-page timing remains inconclusive. |
| Coalesce presence notifications (#471) | Movement notification work falls from 57.0/53.4/68.6 to 9.5/10.8/11.5 ms, improving every pair. | This measures synchronous notification work. It does not establish the same reduction in total frame or page time. |
| Share preparation across render layers (#472) | Combined overlay/outline/marker movement work falls 45.5%, from 532.5/523.0/522.2 to 299.1/279.7/281.6 ms. Whole-page movement task time falls 17.1%, improving every pair. | Hover page time varies. Rendering tasks include work beyond scene preparation. |
| Share label projection bounds (#473) | Movement label work falls from 288.0/265.6/274.2 to 124.9/122.9/135.9 ms, improving every pair. | Whole-page hover remains inconclusive. A follow-up with idle before hover also reduces label work in every pair. |
| Transparent-fragment discard (#470) | No change retained. Movement GPU means are 1.908/1.811/2.090 versus 1.715/1.790/2.311 ms. | The candidate regresses in the third pair; the earlier pre-grouping result does not justify shipping it. |

Unchanged complete claim entries retain identity so the new display-union cache survives repeated snapshots.
Changed labels, expiry, ownership metadata and geometry still arrive. Deleted entries leave the retained set.
Hidden claims bypass preparation; visible groups retain offscreen members so culling cannot split their outline.

[Claim-identity profiles](benchmarks/raid-rebased-467-2026-09-20.json.gz) and
[offscreen-mask profiles](benchmarks/raid-rebased-468-2026-09-20.json.gz) retain all pairs and secondary metrics.
[Hole-hover profiles](benchmarks/raid-rebased-469-2026-09-20.json.gz) also include normal hover, movement and idle recovery.
[Notification profiles](benchmarks/raid-rebased-471-2026-09-20.json.gz) retain task counts and total label work.
[Shared-scene profiles](benchmarks/raid-rebased-472-2026-09-20.json.gz) contain three accepted pairs.
The first attempt at pair 1 missed an input deadline by 757 ms. Both sides of that pair were repeated;
the completed pair 0 was retained. The input deadline was not relaxed.
The first warmed-label comparison was rejected when browser zoom changed its viewport from 1,309 to 1,920 CSS pixels.
The replacement three-pair comparison holds its new viewport constant. Warmed hover label work falls from
531.5/379.0/377.6 to 366.6/277.9/243.4 ms; page time has no consistent improvement.
The initial hover slowdown did not persist consistently in the warmed comparison or the later GPU baseline using the same bundle.

Cold-hover first-label times remain noisy: baseline 642.5/23.6/39.8 ms and candidate 38.3/14.9/1,534.6 ms.
The lazy-component change claims a hole-hover memory benefit, not hitch-free entry.
Profiler on/off pairs likewise show no reliable overhead percentage. The four-times CPU-throttled run and the final
six-scenario visual run pass workload and negative-hover guards, but they do not establish smoothness on slower hardware.
[Additional browser evidence](benchmarks/raid-additional-browser-2026-09-20.json.gz) retains these results and the rejected GPU experiment.

### Final rebase limitation

The latest-main baseline and shipping candidate both build successfully. The final integrated comparison stops before sampling:
Wplace and the map load, but the browser has zero templates, no configured collaboration servers and no presence socket.
A read-only check of the original tab confirms the same empty configuration and absent saved `caelestis.state.v2`.
The cause of that configuration loss is unknown. No saved settings were changed to reconstruct the workload.
The runner now preserves setup diagnostics with socket paths, counts and exceptions, without credential query strings.
[Final build provenance and setup failure](benchmarks/raid-shipping-setup-2026-09-20.json) record the limitation.

Consequently, no combined speedup is claimed for the final rebased bundle. The completed individual comparisons above remain
tied to c2121c03. The historical integrated and six-scenario runs in the additional evidence include the subsequently removed
fragment-discard experiment; they are not measurements of the submitted bundle.

### Visual evidence

These inspected screenshots use the c2121c03 workload at the same viewport and zoom. The candidate includes all retained
client optimizations and excludes fragment discard. Claimed coverage, the subtraction hole, borders and hover labels remain visible.
They precede the final main rebase.

| Baseline | Retained client optimizations |
| --- | --- |
| ![Baseline claimed hover](https://i.mia.cx/file/2026/09/rebased-467-0-baseline.json.0-hover-fd7bd5.png) | ![Optimized claimed hover](https://i.mia.cx/file/2026/09/rebased-473-2-candidate.json.0-hover-718ffe.png) |

## Portable backend

The local PostgreSQL 18/filesystem comparison runs 256 users through the production Node and native Bun adapters.
The driver uses CPUs 0–1, backend 2–3 and database 4–5, with 35 seconds of warmup and 60 measured seconds.
Every run preserves the five-second command deadline and 300 ms presence cadence.
These measurements do not establish CNPG/S3 performance.

| Change | Runtime | Baseline CPU seconds | Candidate CPU seconds | Result |
| --- | --- | --- | --- | --- |
| Peer selection (#475) | Node 22.23.2 | 14.401 / 14.552 / 14.615 | 13.132 / 13.470 / 13.355 | 8.3% lower; selection time 44.3% lower. |
| Peer selection (#475) | Bun 1.4.2, native sockets | 12.352 / 12.430 / 12.309 | 10.563 / 10.554 / 10.415 | 15.0% lower; selection time 55.5% lower. |
| Claim publication (#476) | Node 22.23.2 | 13.339 / 13.104 / 13.190 | 9.055 / 9.484 / 9.098 | 30.3% lower. |
| Claim publication (#476) | Bun 1.4.2, native sockets | 10.508 / 10.561 / 10.649 | 8.417 / 8.298 / 8.462 | 20.6% lower. |

Every pair improves CPU beyond the observed baseline range, with zero command deadline misses and exact accounting.
Claim snapshot bytes fall 27.7%, from 2,056,788,900 to 1,487,567,584 per measured run, without losing mutations or ownership.
Latency and memory are secondary metrics; no general end-to-end latency improvement is claimed.
The [final backend summaries and raw-file index](benchmarks/raid-final-backend-2026-09-20.json.gz)
include claim delivery, reconnects, database CPU, memory, stage timings, URLs and hashes.

An earlier baseline failed when concurrent creation added an owner row after the public claim list was read.
Ready, recovery and publication now restrict ownership to the IDs and actors in their outgoing snapshot.
The focused test fails before that fix and passes afterward. Both sides of every final backend comparison include this guard.
[Rejected-run diagnostics](benchmarks/raid-rejected-runs-2026-09-20.json.gz) preserve the ownership failure and viewport interruption.
Earlier native measurements above this report's date are historical; the table here uses the complete rerun.

### CNPG/S3 and remaining lane cost

Production Node 24.20.0 and Bun 1.4.2 images run in disposable kind clusters, with two CNPG PostgreSQL 17.6 instances
and MinIO. Database TLS is verified. HTTP/WS uses an owned loopback NodePort through the Node frontend.
This stack does not reproduce production HTTPS ingress or Longhorn. Each comparison uses 35 seconds of warmup and
120 measured seconds; shorter initial runs failed the unchanged CPU-coverage guard and were not accepted.
Backend/frontend limits are two CPUs each; PostgreSQL and S3 limits are one each.
Reported full-stack resources cover five application containers, excluding operators, storage engines, node services and the driver.

| Claim expiry/recovery (#477) | Baseline mean claim-list ms | Candidate mean claim-list ms | Result |
| --- | --- | --- | --- |
| Node | 1.367 / 1.207 / 1.128 | 1.019 / 1.013 / 1.042 | Every pair improves; overall CPU and mutation latency remain inconclusive. |
| Bun | 1.135 / 1.159 / 1.196 | 1.116 / 1.099 / 1.034 | Every pair improves; overall CPU and mutation latency remain inconclusive. |

All twelve runs pass strict deadlines, exact accounting, claims and peer convergence.
Tile-lane queue medians remain 0.003–0.005 ms, versus roughly 4–5 ms occupied time.
The historical 455 ms median queue wait is not reproduced. #478 therefore retains diagnostics and leaves transaction
serialization, isolation, reservation ordering and ownership fences unchanged. No lane-speedup claim is made.

Each final capacity point runs once with the same five-second deadline and 300 ms presence cadence.
Counts above 256 explicitly raise only the disposable stack's subscriber admission limit.

| Runtime | Stable 256 | Raid 288 | Raid 320 | Raid 384 |
| --- | --- | --- | --- | --- |
| Node | Pass | Pass | Pass | Pass |
| Bun | Pass | Pass | Pass | Fail: final peer set did not converge |

The Bun 384 run has zero recorded command deadline misses but fails correctness, so it is not a capacity pass.
These are observed results for this test stack, not production capacity guarantees. All owned kind clusters were removed;
the user's unrelated Docker containers remain running. The ten-user Miniflare raid also passes, including room-local timing RPC.

### Recovery preparation

The real compiled coordinator restores 256 socket attachments against SQLite, with 255 authenticated sockets and one anonymous viewer.
Different credentials sharing a painter retain distinct ownership. Each pair uses one warmup and five measured recoveries.
At 37 claims, median preparation time falls from 24.39/39.31/23.45 to 12.40/11.91/12.21 ms.
At 512 claims, it falls from 148.01/142.03/145.93 to 96.60/87.12/86.90 ms.
Both variants include the ownership snapshot guard.
All three pairs preserve exact ownership; owner-list reads fall from 255 to one.
This measures room recovery preparation, excluding network transport and deployed Workers latency.
[Recovery samples](benchmarks/raid-rebased-recovery-2026-09-20.json.gz) retain individual times and CPU measurements.

## Repository checks

`pnpm lint`, `pnpm check`, `pnpm test --concurrency=1`, `pnpm build`, and
`CHANGESET_BASE_REF=origin/main pnpm test:release` pass after the rebase.
The final run on main 05088c8e includes 1,620 userscript, 920 backend and 214 frontend tests, with all eleven Turbo tasks passing.
Shared, UI, wire-schema and storage suites also pass; all 52 release checks pass.
Fifteen environment-specific backend tests skip.
Separate SQLite, D1-emulation, PostgreSQL 17 and MariaDB 11.8 contracts pass 171 region/connection cases.
Owned SQL test containers are removed afterward.

The newly merged deletion trigger exposed semicolon splitting in two Miniflare migration loaders.
Both now use the installed Wrangler SQL splitter. The workerd test preserves 100,000 painted pixels
through live framing and acknowledgement replay.

## Reproducing the comparisons

[The frozen-build recipe](benchmarks/rebuild-raid-2026-09-20.mjs) reconstructs the measured variants from the source bundle linked in the
[raw-file index](benchmarks/raid-raw-files-2026-09-20.json). That index also links the full native samples and CNPG/capacity results with SHA256 hashes.
The bundle preserves pre-rebase commit IDs and requires public main commit c2121c03 as its prerequisite.
Import it with `git fetch measured-source.bundle t3code/profile-userscript-during-raid:raid-measured`, then use an isolated checkout
of `raid-measured` so shared packages and dependencies also match the measurements.
Run it at the repository root after installing dependencies and building shared packages.
It writes complete browser bundles and compiled Node/Bun backend directories into a new temporary directory.
Its final source is `21aef479`; the later SQL-splitter commit changes benchmark loaders only.
The original manifest called that source `f8c732d2` before a documentation fixup rewrote commit hashes.
The source and final bundle hash remain identical.

Browser variants form a cumulative sequence: base, 467, 468, 469, 471, 472, 473, final.
Every post-base variant includes the reconciled claim-identity function needed by main's new union cache.
The recipe removes a stale unused `item.document` expression in intermediate archived layers.
Backend 477 includes the common snapshot guard from ebf78847. Backend 476 removes expiry/recovery changes; 475 also removes publication changes;
474 also removes peer-selection changes. All retain identical timing instrumentation.
The backend result's `commit` field identifies the devbox driver checkout, not these frozen builds.
Use `backendSha256`, browser `bundleSha256`, source hashes and CNPG image IDs for measured-artifact identity.

```sh
node docs/benchmarks/rebuild-raid-2026-09-20.mjs
# Substitute the printed directory below.
RAID_TEMPLATES=97 RAID_HOVER_MS=10000 RAID_SCENARIOS=hover,movement,idle \
  node scripts/runtime-benchmark/compare-builds.mjs browser \
  /tmp/FROZEN/rebased-471.user.js /tmp/FROZEN/rebased-472.user.js test-results/scene
BENCH_USERS=256 BENCH_SCENARIO=raid BENCH_VARIANTS=node,bun-native \
  taskset -c 0,1 node scripts/runtime-benchmark/compare-builds.mjs backend \
  /tmp/FROZEN/backend-474/apps/backend/dist /tmp/FROZEN/backend-475/apps/backend/dist \
  test-results/selection
```

Use `hole,hover,movement,idle` for #469, and `RAID_HOVER_MS=30000` for the integrated browser comparison.
The backend command needs Linux, Docker, PostgreSQL's pinned image and Bun on PATH or `BUN_BINARY`.
All comparisons alternate baseline/candidate, candidate/baseline, baseline/candidate, checking fixed workload signatures.
