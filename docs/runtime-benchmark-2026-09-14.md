# Node, Bun and Miniflare with Box Art traffic

Tracks [#385](https://github.com/mia-riezebos/Caelestis/issues/385) in [PR #351](https://github.com/mia-riezebos/Caelestis/pull/351).

All 27 cases at 10, 100 and 256 users pass. All nine 1,000-user cases time out during warmup. Bun consistently uses less memory, but does not solve the overloaded workload.

The benchmark uses Node 24.20.0 and Bun 1.4.2 on an AMD Ryzen 9 7950X Linux host. The driver, backend and PostgreSQL instance have separate CPU affinity assignments. Each backend gets two logical CPUs. PostgreSQL 18 runs locally, with a fresh database for every case; objects use the filesystem.

The fixture is the same 1612×2584 Box Art export used for laptop testing, at its original canvas coordinates. Seventy percent of users explore with pans, zoom changes and pauses. Thirty percent paint 30 pixels every 30 seconds, publish draft changes at most once per second, and make small viewport adjustments every 12 seconds. Painting and adjustments have staggered phases. Each user has a reporting token, a browser client ID, and both authenticated WebSocket channels.

The simulation offers covered canvas tiles and uploads the versions requested by the backend. Synthetic canvas snapshots reflect completed paints at five-second intervals. These are modelled sessions, not captured production traffic. Painters are assumed to have stored charges available. Browser rendering, Wplace downloads, S3, TLS, Traefik, failover and long-term memory growth are outside this comparison.

Every successful case has 35 seconds of warmup followed by 60 measured seconds. Three repetitions rotate the order of Node, Bun with the existing Node adapter, and Bun with an experimental native HTTP/WebSocket bridge. The application, database driver, coordinators and socket queues stay the same. The native bridge does not use Bun-specific SQL or pub/sub optimizations.

Numbers below are medians of three runs. CPU is average utilization as a percentage of one core. Memory is sampled process RSS. Each latency column is the median of the three per-run p95 values.

| Users | Runtime | CPU | Mean RSS | Paint acknowledgement p95 | Tile upload p95 | Viewport delivery p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10 | Node | 1.97% | 181 MiB | 20.1 ms | 98.4 ms | 300.4 ms |
| 10 | Bun, Node adapter | 1.89% | 148 MiB | 19.9 ms | 66.4 ms | 300.7 ms |
| 10 | Bun, native bridge | 1.88% | 141 MiB | 19.8 ms | 67.3 ms | 300.9 ms |
| 100 | Node | 8.58% | 348 MiB | 21.2 ms | 162.2 ms | 288.6 ms |
| 100 | Bun, Node adapter | 9.16% | 191 MiB | 22.3 ms | 110.0 ms | 291.5 ms |
| 100 | Bun, native bridge | 9.04% | 185 MiB | 21.8 ms | 117.8 ms | 290.3 ms |
| 256 | Node | 18.03% | 384 MiB | 113.0 ms | 376.3 ms | 298.9 ms |
| 256 | Bun, Node adapter | 21.08% | 250 MiB | 51.6 ms | 294.5 ms | 301.4 ms |
| 256 | Bun, native bridge | 20.70% | 238 MiB | 54.8 ms | 303.8 ms | 301.7 ms |

At ten users, Bun reduces resident memory by 18–22% and improves tile-upload latency. Paint and viewport latency remain similar. The server intentionally batches presence every 300 ms; the phase of that timer contributes to variation between runs.

At 100 users, all nine cases pass. Bun reduces resident memory by 45–47% and tile-upload p95 by 27–32%. Paint and viewport latency remain similar. Node's median CPU utilization is 5–6% lower, but individual runs overlap. Node ranges from 7.48% to 9.22% of one core; the Bun variants range from 8.77% to 9.44%. Native Bun does not show a consistent latency advantage over its Node-compatible adapter.

Each measured 100-user run sends 10,346 presence updates, 322 tile offers and 60 paint reports. Requested uploads vary from 24 to 26 with server timing. Each receives 2,400 status deltas. The load generator's worst per-run p99 dispatch delay is 1.02 ms.

The 256-user follow-up uses 179 explorers and 77 painters, rounding the 70/30 split to whole users. All nine cases pass with 512 sockets at the unchanged production live-sync limit. This count assumes one live-sync connection per user; additional tabs and frontend subscribers also consume slots.

At 256 users, Bun uses 35–38% less memory and 15–17% more CPU than Node. Its median paint p95 is 52–54% lower, and tile-upload p95 is 19–22% lower. Individual paint p95 values vary: Node 84–148 ms, Bun compatibility 48–85 ms, and native Bun 49–60 ms. Viewport delivery remains around the server's 300 ms batching interval.

Every measured 256-user case sends 26,466 presence updates, 835 tile offers and 154 paint reports. Requested tile uploads vary from 49 to 62, so processing volume is not identical despite the same offered trace. Each final check confirms 243 persisted paint events and 7,290 pixels including warmup. The highest per-run load-generator p99 dispatch delay is 1.31 ms. These short local runs establish that this workload fits the admission limit; they do not guarantee capacity for an arbitrary event turnout.

Production currently limits live-sync subscribers to 256. The 1,000-user experiment changes only this constant in a disposable compiled copy, to admit the requested 2,000 sockets. The original build, deployed server and its limits stay unchanged. The 2,048-presence-subscriber and 64-nearest-peer limits still apply.

All nine final 1,000-user cases admit 2,000 sockets, then hit the userscript's five-second command deadline during warmup. None reaches the measured phase. The following CPU and memory numbers describe the partial warmup only.

| Runtime | Completed cases | Traffic duration before failure | Median CPU | Median mean RSS | First failed command |
| --- | ---: | ---: | ---: | ---: | --- |
| Node | 0/3 | 10.07–10.12 s | 73.49% | 421 MiB | Tile offer in all three |
| Bun, Node adapter | 0/3 | 10.23–10.30 s | 78.59% | 351 MiB | Tile upload in all three |
| Bun, native bridge | 0/3 | 10.25–10.31 s | 76.60% | 300 MiB | Two tile offers, one tile upload |

Backend event-loop delay p95 ranges from 178 to 213 ms. PostgreSQL uses 0.65–0.77 CPU seconds per partial run. Load-generator dispatch p99 stays below 10 ms in eight cases. One Node case reaches 63 ms p99 and 161 ms maximum dispatch delay. The same timeout occurs in the other two Node cases with timely dispatch. These results identify failure under this specific workload; they do not establish the maximum supported user count.

A separate diagnostic Node CPU profile points to full-tile classification, mismatch-mask generation, presence filtering and attachment cloning as substantial work. That profile includes setup and draining; it is diagnostic evidence, not a timed comparison result.

Keep Node as the supported default for now. Bun's strongest repeatable benefit here is lower memory use, followed by faster tile uploads. The native bridge adds implementation work without a clear advantage over compatibility mode. Investigate tile classification and presence processing before expecting either runtime to support this 1,000-user workload. Any Bun adoption still needs the database/storage compatibility matrix and longer recovery tests.

Successful runs verify requested online counts, all claim snapshots, exact final nearest-peer sets, viewport rectangles, decoded draft pixels, persisted paint totals, and duplicate rejection. Failed runs retain the phase, partial CPU and memory measurements, completed-command latency samples, errors and generator lateness. Those latency samples are censored by failure and cannot be ranked against successful runs.

The initial benchmark source is pinned at `c737aedb`; the 256-user follow-up uses `7318e341`, which adds the allowed count and rounds the split to whole users. The application build is unchanged. [The initial 27 per-run summaries](benchmarks/runtime-2026-09-14.json) and [nine 256-user summaries](benchmarks/runtime-256-2026-09-14.json) include source hashes, traffic trace hashes, fixture hashes, runtime versions and the PostgreSQL image ID. Reproduction instructions are in [the benchmark README](../scripts/runtime-benchmark/README.md). Raw traces, per-run samples, logs and the diagnostic CPU profile remain under `test-results/runtime-benchmark/`. The archived summaries hash each complete fixture-frame list instead of repeating it.

The retained k3s laptop-testing stack remains running. These experiments use disposable local processes, databases and files.

[Issue #386](https://github.com/mia-riezebos/Caelestis/issues/386) tracks peer sharding and k3s autoscaling separately. It uses all-shards upper/lower thresholds, forecasts scale-up batches from influx and observed startup time, and drains only for scale-down. Its k3s example proposes a custom policy controller because a standard HPA averages pod metrics. Sharding remains future work; this benchmark measures one application process.

The Miniflare follow-up uses the production Worker with all five Durable Object bindings, local D1, and local R2. Miniflare 5.20260910.0-alpha launches workerd 1.20260910.1 through Node 24.20.0. The compatibility date is 2026-08-03 with `nodejs_compat`, matching the Worker configuration. Miniflare runs the Worker in workerd's V8 isolates; Node also uses V8. [Cloudflare local development](https://developers.cloudflare.com/workers/local-development/), [Workers runtime](https://developers.cloudflare.com/workers/reference/how-workers-works/)

All three 256-user Miniflare repetitions pass the same correctness checks, with the identical traffic trace and fixture as the Node/Bun follow-up. Each has 35 seconds of warmup and 60 measured seconds. They run as a later separate batch, not interleaved with Node/Bun. These measurements compare local runtime-and-adapter combinations, not JavaScript engines alone or Cloudflare production performance.

| 256 users | Node + PostgreSQL/filesystem | Bun compatibility + PostgreSQL/filesystem | Bun native + PostgreSQL/filesystem | Miniflare + local D1/R2/DO |
| --- | ---: | ---: | ---: | ---: |
| Paint acknowledgement p95 | 113.0 ms | 51.6 ms | 54.8 ms | 77.3 ms |
| Tile upload p95 | 376.3 ms | 294.5 ms | 303.8 ms | 268.3 ms |
| Viewport delivery p95 | 298.9 ms | 301.4 ms | 301.7 ms | 329.0 ms |

Miniflare's median paint p50 is 3.44 ms. Its per-run paint p95 ranges from 75.9 to 91.5 ms. Requested tile uploads range from 47 to 52, versus 49–62 for Node/Bun. The highest per-run generator p99 dispatch delay is 1.41 ms. Miniflare logs `presence socket close failed` during client teardown after correctness checks; all processes still dispose successfully. The underlying close-error cause is not investigated in this comparison.

Miniflare uses a median 23.54% of one core across workerd and its controller. Summed mean RSS is 973 MiB, comprising about 765 MiB for workerd and 209 MiB for the controller. Workerd includes local D1/R2/DO emulation. CPU is split by process in the results; no isolate event-loop measurements are claimed. Summed RSS can count shared pages twice.

The Node/Bun memory figures above cover only the application process. Their PostgreSQL CPU is measured separately, and database memory is not captured. Do not compare those application-only figures with Miniflare's combined footprint as complete hosting-stack totals.

A read-only snapshot of the retained k3s stack reports 425 MiB across its Node backend (97), frontend (59), two CNPG database pods (61 and 89), and MinIO (119). The test-assets pod adds 24 MiB. Shared Traefik, operators and node services are excluded. This is Kubernetes-reported container memory at the stack's current low load, not RSS or a matched 256-user Bun/CNPG measurement. No full-stack memory winner is established.

[The three Miniflare summaries](benchmarks/runtime-miniflare-256-2026-09-14.json) retain source, fixture and bundle hashes. All three use the same bundle. The application baseline is `55804bd2`, before the later remote collaboration changes. Benchmark commit `09ddcc17` was subsequently rebased as `b56b9dd1`; the measurements retain their original provenance. Reproduce that historical case with application source from `55804bd2` and benchmark scripts from `b56b9dd1`. Raw logs and samples remain under `test-results/runtime-benchmark/final-miniflare-256/`.

Issue #385 also tracks version-matched Node and Bun image tags so operators can choose a runtime. Publishing those variants still requires compatibility and recovery validation.
