# Collaboration performance

Issue #372 measures the complete userscript on Wplace in one signed-in Chromium tab.
The tab loads the existing templates and claims. Controlled peer messages enter the real
presence socket's message handler, so parsing, state updates, the drawer, MapLibre rendering,
and hover labels all run through production code. The fixture never sends invented peers to a server.

## Reproduce

Build the userscript and start the debug Chromium with the normal browser command. Keep one
Wplace tab open. The runner uses that tab, reloads it with the supplied bundle, and keeps
Caelestis settings writes in memory. It requires an existing presence connection and claims.
Close the previous benchmark tab before changing bundles. Start with no Wplace tabs to let
the runner create a fresh one. A development watcher must not inject another build into that tab.

```sh
pnpm --filter @caelestis/userscript... build
node apps/userscript/chromium.mjs
node scripts/benchmark-wplace-collaboration.mjs \
  apps/userscript/dist/wplace-template-server.user.js /tmp/collaboration.json 3
```

The fixed camera looks at the Box art claims. Adjust it for another installation. Browser zoom
was verified at 110% in Chromium's toolbar. Each scenario warms for 1.5 seconds, then samples
24 steps spaced 300 ms apart. Native paint interactions and CDP dispatch add to elapsed time.

| Scenario | Workload |
| --- | --- |
| Idle presence | One stationary peer; pointer over a real claim; userscript drawer open |
| Active painting | Native black draft clicks, one updating remote draft, and the open userscript drawer |
| Map movement | Repeated camera movement and remote viewport/draft messages |
| Simultaneous players | 64 incoming peers with viewport updates and 64-pixel draft masks |

Native drafts are cancelled. The runner never presses the paint submission button. Peer replay
tests client-side concurrency; it does not benchmark server fan-out or network latency. This
page-context injection follows the repository's development runner and does not test manager sandbox injection.

## Reading the measurements

`Performance.getMetrics` supplies whole-page main-thread task, script, layout, and heap measurements.
The exported profiler attributes Caelestis work and records frame intervals. Nested `detail` timings
stay outside aggregate CPU totals. Frame cadence does not establish input-to-display latency.

Presence and live paint byte counters measure UTF-8 application payloads, excluding transport framing
and compression. Divide totals by elapsed seconds to obtain rates. Known memory includes region masks,
component label arrays, and R8 GPU masks; object and driver overhead are excluded.

The discarded synthetic and multi-tab probes are not performance acceptance evidence.
Use matched single-tab runs and check their template, claim, peer, draft, and message counts.

## Results, 13 September 2026

The width cache and last-cluster cache reduce idle hover label CPU by 79% and 64-peer label CPU
by 77%. Whole-page task duty falls 5.4% and 7.7%, respectively. Map movement does not show a
whole-page CPU improvement. Frame cadence remains about 60 FPS; these runs establish CPU
savings, not a frame-rate improvement.

Both builds used Chromium 150, 110% browser zoom, a 1745 × 1016 CSS viewport, and DPR 2.2.
They loaded 92 templates, with 91 enabled, and two real claims containing 19 shapes and
2,413,620 bounding pixels. Camera and label text/positions match. The after run preceded
the repeated baseline run; each used a fresh tab with no other Wplace tab open.

Values below are medians of matching samples. Idle uses three before and two after samples.
Movement and 64 peers use three each. Painting has only one matching sample per build and
should be treated as a single comparison. It contains 12 native drafted pixels, one remote
64-pixel draft, and 24 incoming messages. Samples containing an additional server refresh
or only 11 native drafted pixels are retained in the raw files but excluded here.

| Scenario | Page task duty, before → after | Label CPU per call, ms | Frame p95, ms | Samples, before / after |
| --- | --- | --- | --- | --- |
| Idle presence | 27.50% → 26.02% | 0.960 → 0.205 | 18.40 → 18.35 | 3 / 2 |
| Native painting | 30.11% → 29.64% | 0.516 → 0.105 | 18.00 → 18.50 | 1 / 1 |
| Map movement | 26.58% → 27.16% | 0.294 → 0.207 | 18.20 → 18.50 | 3 / 3 |
| 64 peers | 27.84% → 25.69% | 1.068 → 0.250 | 18.00 → 18.00 | 3 / 3 |

Idle clustering falls from a median 436 calls to zero during the warm sample. The 64-peer
scenario falls from 469 to zero. DOM width probes also fall to zero in those warm samples.
The caches retain one cluster per claim and at most 128 text widths. Resize and font loading
invalidate widths; changed geometry, camera, component, width, or scale invalidates clustering.

Known collaboration buffers are identical before and after: 4,827,240 bytes of component labels,
2,413,620 bytes of region masks, and 2,413,620 bytes of GPU masks when idle. Remote drafts add
64 GPU bytes for one painter or 4,096 for 64 painters. Whole-page heap snapshots vary with GC:
the idle median is 36.8 → 57.9 MiB, painting 64.6 → 40.2 MiB, movement 57.4 → 50.4 MiB,
and 64 peers 35.8 → 54.3 MiB. They do not establish a retained-heap increase or reduction.

The optimization changes no protocol payloads. Matched idle samples send and receive nothing.
Painting receives 24 messages / 6,888 bytes and sends 8 / 844 bytes. Movement receives
24 / 6,888 bytes and sends 14 / 1,092 bytes. The 64-peer scenario receives 24 / 354,240 bytes,
about 3.2 messages/s and 48 kB/s, and sends nothing. Incoming replay bytes measure client
processing workload, not actual network transfer.

### Evidence and validation

Compressed exports retain every attempt, including excluded samples. Label text is hashed;
matching hashes and transforms verify placement without publishing player names.

- [Baseline exports](benchmarks/372-wplace-before.json.gz), bundle SHA-256 `102e8cf12b968f6fdee125ae3d797224af5cf1cc043cdc1219fde906d3934533`.
- [Optimized exports](benchmarks/372-wplace-after.json.gz), bundle SHA-256 `acf1ab80e4b5023808b78da754677189a3d79879640b7f5c09aba64ffc479e81`.
- [Rebased build verification](benchmarks/372-wplace-final.json.gz), one successful pass through all four scenarios.

The paired builds precede the rebase onto the shortcut-settings changes in `2cd15009`.
The final verification runs the rebased build at `1d7913e8`; it is not mixed into the performance comparison.
Use `gzip -dc docs/benchmarks/372-wplace-before.json.gz` to inspect an export.

Focused tests cover cache invalidation and reuse, received state updates, and disabled profiling
without UTF-8 allocation. The cache tests failed before the fix and pass after it. Shared/UI
builds, userscript typecheck/build, and 53 focused tests pass after rebase. Earlier full package
tests passed 239 shared tests, 145 UI tests, and 1,477 userscript tests; the remaining watcher
test timed out under parallel load and passed in isolation. Lint and 37 release checks pass.
Native drafts were cancelled after every scenario; no public paint was submitted.

Review follow-up verified the runner's failure path on Wplace. An injected screenshot-write error
left 12 native draft pixels active before the fix. With scenario cleanup in `finally`, the same
error leaves paint closed and zero drafted pixels. Exports now hash labels in the runner itself;
the generated hashes and positions match the previously captured text, which is absent from JSON.
All 1,893 package tests, dependency builds/typechecks, lint, and 37 release checks pass after these fixes.
