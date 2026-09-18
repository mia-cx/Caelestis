# Tile-processing latency at 256 users

On the final images, Bun passes the strict 256-user CNPG/S3 run and Node still misses the userscript's five-second deadline during warmup.
The shared processing named in [#397](https://github.com/mia-riezebos/Caelestis/issues/397) is fixed and no longer measurable on either runtime.
The remaining wait on both is the Postgres adapter's single owned connection, which serializes every application query; Node spends four times longer in that queue than Bun.
Changing that touches ownership fencing, so this report stops at the evidence and the options.
A capacity ladder on the same images puts one server at 256 users on Bun, passed twice, with 288 and above failing in warmup; Node passes at 224 and fails at 256.
Two passing Bun runs establish that the workload completes at 256; they are not the three alternating repetitions the benchmark README asks for before ranking runtimes.

## What changed on the branch

- Classification uses typed-array kernels and is shared across reporters per template chunk and canvas hash.
- A canvas hash's bytes are stored once, even when reporters overlap before the first commit.
- Derived mismatch artifacts are written after the reply by a bounded background writer.
- The tiles of one offer batch are processed concurrently; a tile's history folds on its first observation and then at most every 30 seconds, with overlapping observations joining the fold in flight.
- An alarm change reads and encodes one snapshot per scope for all subscribers; a status delta is encoded once.
- The Node live host no longer clones a socket's attachment on every read.
- Every live command records per-stage timings, and the Postgres adapter records connection turn wait and statement time.

## Matched CNPG/S3 workload

The driver, trace, fixture, limits, and placement match the [September 14 report](bun-runtime-validation-2026-09-14.md).
Runs were driven from the devbox `athena-hephaestus` against the same two-node k3s cluster.
Backend, frontend, and MinIO ran on `hydra-olympus-2`; the CNPG primary landed on either node.
Each run built the three production images from the branch head at the time and imported them to both nodes.

| Strict Node run | Revision | Added since the previous run | Failure | Upload p95 | Offer p95 | Paint p95 |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 1 | a676921a | reviewed fixes | tile-offer timed out | 4.5 s | 3.6 s | 4.3 s |
| 2 | 5a26485a | concurrent offer tiles, throttled folds | paint-report timed out | 2.8 s | 3.3 s | 5.0 s |
| 3 | e72b00e8 | one alarm read per scope | paint-report timed out | 2.1 s | 2.4 s | 4.3 s |
| 4 | 66e17436 | no attachment clone, one delta encoding | paint-report timed out | 2.1 s | 2.4 s | 3.9 s |
| 5 | 040579f9 | turn-wait instrumentation | paint-report timed out | 2.2 s | 2.5 s | 3.8 s |

All five failed about ten to twenty seconds into warmup with all 512 sockets connected. Deadline counters show zero misses
because a timed-out command never receives a reply to count. Final correctness checks were not reached.

The strict Bun run on the same `040579f9` images passed: the 35-second warmup drained, 60 seconds were measured, and every
correctness check held, with 256 users online, 512 sockets, 243 paint events of 7,290 pixels persisted exactly, duplicates
rejected, final peer sets and drafts correct, and zero deadline misses in either phase.

| Strict Bun run, measured phase | Value |
| --- | ---: |
| Tile upload p50 / p95 / max | 573 / 918 / 1,224 ms |
| Tile offer p50 / p95 / max | 69 / 865 / 1,151 ms |
| Paint report p50 / p95 / max | 127 / 946 / 1,163 ms |
| Presence delivery p50 / p99 | 195 / 405 ms |
| Backend CPU, percent of one core | 69.0% |
| Backend RSS, median / peak | 254 / 266 MiB |
| Full-stack CPU, percent of one core | 117.0% |
| Full-stack RSS, median / peak | 665 / 685 MiB |
| CNPG containers CPU | 3.9% and 5.8% |
| MinIO CPU | 12.7% |

Full-stack resources sum the backend, frontend, two CNPG instances, and MinIO, as in the September report.
The Bun backend executed 30,547 statements at 0.9 ms p50 and waited 85 ms p50 and 239 ms p99 for its connection turn.

## Capacity ladder

With the shared processing fixed, the question was how many users one server sustains now.
The trace size comes from `CAELESTIS_TEST_BENCHMARK_USERS` and the backend's 256-subscriber cap was raised to 2,048 through
`CAELESTIS_LIVE_SUBSCRIBER_LIMIT` for these runs only; presence already admits 2,048. Explorers stay at 70 percent of users.
Every rung is a strict run with the five-second deadline, on the same images, limits, and placement.

| Runtime | Users | Sockets | Result | Upload p95 | Paint p95 | Turn wait p50 / p99 | Backend CPU |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| Bun | 256 | 512 | passed | 918 ms | 946 ms | 85 / 239 ms | 69.0% |
| Bun | 256 (repeat) | 512 | passed | 1,026 ms | 1,001 ms | 69 / 254 ms | 70.2% |
| Bun | 288 | 576 | paint-report timed out in warmup | 2,219 ms | 4,276 ms | 235 / 421 ms | — |
| Bun | 320 | 640 | paint-report timed out in warmup | 2,204 ms | 4,495 ms | 228 / 448 ms | — |
| Bun | 384 | 768 | paint-report timed out in warmup | 3,358 ms | 3,501 ms | 513 / 838 ms | — |
| Node | 256 | 512 | paint-report timed out in warmup | 2,249 ms | 3,771 ms | 351 / 823 ms | — |
| Node | 224 | 448 | passed | 1,312 ms | 1,514 ms | 81 / 276 ms | 79.1% |
| Node | 192 | 384 | traffic completed, zero misses; collector rejected its CPU window | 868 ms | 738 ms | 68 / 324 ms | — |
| Node | 192 (repeat) | 384 | traffic completed, zero misses; collector rejected its CPU window | 968 ms | 782 ms | 68 / 248 ms | 65.7% |

Passing rows report the measured phase; failing rows report the warmup burst up to the timeout, where every client connects and offers within seconds.
Statement execution stayed at 0.9 ms p50 and CNPG below 6 percent CPU on every rung, so each rung failed in the same queue.
Both Node runs at 192 drained warmup and finished the measured phase with every command inside the deadline, but the resource
collector then rejected a kubelet CPU window as insufficient and aborted before the final peer-set and draft checks, so they
are recorded as traffic passes rather than full passes.

The answer today is 256 users on Bun, twice, with paint p99 between 1.2 and 3.7 seconds against the 5-second deadline, and 224 users on Node,
with every correctness check and paint p99 at 1.8 seconds. Bun fails at 288 and Node at 256, so each ceiling sits within one rung of its last pass.
Both ceilings are set by the serialized owner connection described below, not by CPU, memory, storage, or the database.

## Where the time goes

Backend stage timings from run 5, in milliseconds, with the last 512 samples per stage:

| Stage | Count | p50 | p99 |
| --- | ---: | ---: | ---: |
| `sql.statement` (execution on CNPG) | 10,216 | 1.0 | 8.3 |
| `sql.poolWait` (wait for a connection turn) | 7,839 | 351 | 823 |
| upload `targets` (one indexed select) | 134 | 213 | 751 |
| upload `reserve` | 67 | 379 | 815 |
| upload `commit` | 67 | 308 | 849 |
| upload `classify` | 67 | 0.04 | — |
| upload `decode` | 67 | 0.03 | 279 |
| upload `artifacts` | 67 | 0.3 | — |
| upload `historyFold` | 67 | 0.03 | — |
| paint `counters` | 40 | 1,984 | 5,639 |
| paint total | 40 | 2,942 | 6,009 |

Statement execution totalled 16 seconds over an 18-second window on one connection. Turn waits totalled 469 seconds.
The backend used 70 percent of one core; the two CNPG containers used 2 and 5 percent; MinIO used 9 percent.
Shared classification served 183 of 196 classifications; 50 of 59 uploads skipped their blob PUT; 188 of 196 folds were skipped.

Two 20-second inspector profiles were taken in observe mode and are excluded from resource comparisons.
The first, on run 3's build, attributed 20.1 percent of samples to `structuredClone` under the Node live host's attachment reads.
The second, on run 4's build, showed 62.7 percent idle, `writev` at 5.8 percent, canvas decoding at 4 percent, and nothing else above 1.1 percent.
The event loop is not the constraint any more.

## The remaining constraint

`apps/backend/src/adapters/node/postgres-connection.ts` claims the ownership advisory lock on one pooled client at startup.
After that, `withClient` runs every application query on that one client, chained one after another.
The ten-connection pool is never used for application work. A transaction holds the queue for all of its round trips.
That is why a one-millisecond select measures hundreds of milliseconds while the database is idle: it waits its turn behind every command of 512 sockets.
The MariaDB adapter follows the same design. Bun uses the same adapter and the same queue; it passes because its turn wait is a quarter of Node's at the same statement time, which leaves the paint path under the deadline with a p99 of 3.7 seconds.
Node's warmup burst, when every client connects and offers at once, does not fit through the queue in time.

This is the fencing that guarantees no query runs after ownership is lost, so it is not changed here. Options, for a decision:

1. Hold the advisory lock as a shared lock on every pooled session and let a competitor request the exclusive lock. A takeover can only happen after every session of the old owner is gone, which is stricter fencing than today, and application queries can use the pool. MariaDB has no shared advisory locks and needs its own scheme.
2. Keep writes on the owned connection and serve reads from the pool. Reads after a lost ownership are stale but harmless. This removes roughly a third of the queue.
3. Verify the owner's lock inside every pooled transaction. Simple, but leaves a millisecond window between the check and the commit.

Raising the pool size, client deadlines, or subscriber limits does not help, because the pool is not in use.

## Evidence and cleanup

The [compact results](benchmarks/tile-processing-cnpg-s3-2026-09-18.json) hold sent and received counts, latencies, stage timings, correctness, measured-phase resources, profile summaries, and container CPU for every run.
Raw reports, samples, and both `.cpuprofile` files remain under `~/Caelestis-397/test-results` on the devbox.
Two runs before run 2 failed to provision because both nodes had fallen under Longhorn's 25 percent free-space floor; unused container images were pruned on both nodes through `kubectl debug`, nothing else was touched.
All test namespaces, volumes, and imported image references were removed after the last run.
