# Tile-processing latency at 256 users

On the final images, both runtimes pass the strict 256-user CNPG/S3 run with every correctness check and zero deadline misses.
The shared processing named in [#397](https://github.com/mia-riezebos/Caelestis/issues/397) is fixed and no longer measurable on either runtime.
The Postgres adapter no longer serializes every application query on one owned connection: queries run on the pool under a two-lock fence, and only transactions on the tile tables take turns.
Node passes with upload p95 at 2.5 seconds and paint p95 at 0.3 seconds against the five-second deadline, at 96 percent of one core; Bun passes with upload p95 at 0.8 seconds and paint p95 at 0.2 seconds at 66 percent.
A capacity ladder on the pooled images is recorded below.
One passing run per runtime establishes that the workload completes; they are not the three alternating repetitions the benchmark README asks for before ranking runtimes.

## What changed on the branch

- Classification uses typed-array kernels and is shared across reporters per template chunk and canvas hash.
- A canvas hash's bytes are stored once, even when reporters overlap before the first commit.
- Derived mismatch artifacts are written after the reply by a bounded background writer.
- The tiles of one offer batch are processed concurrently; a tile's history folds on its first observation and then at most every 30 seconds, with overlapping observations joining the fold in flight.
- An alarm change reads and encodes one snapshot per scope for all subscribers; a status delta is encoded once.
- The Node live host no longer clones a socket's attachment on every read.
- Every live command records per-stage timings, and the Postgres adapter records pool wait, statement time, lane wait, and serialization retries.
- PostgreSQL and CNPG application queries run on the connection pool. The owner session keeps the exclusive ownership lock; every pooled session holds a shared session lock and verifies that this process's owner session still holds the ownership lock; a replacement owner must hold the session key exclusively once, which the database grants only after every session of the old process has closed; a lost owner session ends its pool at once.
- Transactions on the tile tables take turns in one lane, the coordinator's callback transactions in another, and everything else overlaps; serialization failures are retried with a jittered backoff and the first twenty per process are logged with the statement and the database's reason.
- `tile_blob_reservations` has an index on its expiry, which every reservation sweeps.

## Matched CNPG/S3 workload

The driver, trace, fixture, limits, and placement match the [September 14 report](bun-runtime-validation-2026-09-14.md).
Runs were driven from the devbox `athena-hephaestus` against the same two-node k3s cluster.
Backend, frontend, and MinIO ran on `hydra-olympus-2`; the CNPG primary landed on either node.
Each run built the backend images from the branch head at the time and imported them to both nodes.

| Strict Node run | Revision | Added since the previous run | Result | Upload p95 | Offer p95 | Paint p95 |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 1 | a676921a | reviewed fixes | tile-offer timed out | 4.5 s | 3.6 s | 4.3 s |
| 2 | 5a26485a | concurrent offer tiles, throttled folds | paint-report timed out | 2.8 s | 3.3 s | 5.0 s |
| 3 | e72b00e8 | one alarm read per scope | paint-report timed out | 2.1 s | 2.4 s | 4.3 s |
| 4 | 66e17436 | no attachment clone, one delta encoding | paint-report timed out | 2.1 s | 2.4 s | 3.9 s |
| 5 | 040579f9 | turn-wait instrumentation | paint-report timed out | 2.2 s | 2.5 s | 3.8 s |
| 6 | b05cf15b | pooled sessions; every transaction overlaps | tile-upload timed out | 4.8 s | 1.2 s | 1.5 s |
| 7 | 113e1e57 | every transaction takes turns | tile-upload timed out | 3.2 s | 2.6 s | 2.7 s |
| 8 | d272b1df | status lane and reservation expiry index | tile-upload timed out | 4.6 s | 0.4 s | 1.6 s |
| 9 | fd335e90 | batches out of the coordinator lane | tile-offer timed out | 4.7 s | 4.6 s | 0.3 s |
| 10 | 6762fbba | one lane for every tile-table batch | passed | 2.5 s | 1.5 s | 0.3 s |

Runs 1 to 9 failed about ten to twenty seconds into warmup with all 512 sockets connected. Deadline counters show zero misses
because a timed-out command never receives a reply to count. Final correctness checks were not reached.
On run 6's images the Bun run failed differently: overlapping SERIALIZABLE commits of one season aborted each other until one upload exhausted its ten retries and was answered `unavailable`, which is the paint loss the ownership guard exists to prevent.
Run 8 measured 3.5 ms per statement instead of 1.0 and no serialization failures at all, because every batch still committed through the callback path and queued in the coordinator lane, so the status lane was a second queue in front of the same one.
Run 9 measured 348 serialization retries for 225 commits: reservations and commits both read and write the reservation and object tables, which are small enough that the planner scans them whole, and under SERIALIZABLE a whole-table read conflicts with any concurrent write to that table however disjoint the rows.
Run 10 queues every batch on a table a tile commit touches in one lane and recorded no retries.

Run 10 passed: the 35-second warmup drained, 60 seconds were measured, and every correctness check held, with 256 users online,
512 sockets, 243 paint events of 7,290 pixels persisted exactly, duplicates rejected, final peer sets and drafts correct, and zero
deadline misses in either phase. The strict Bun run on the same images passed the same checks.

| Strict run, measured phase | Node, run 10 | Bun, run 10's images |
| --- | ---: | ---: |
| Tile upload p50 / p95 / max | 956 / 2,477 / 2,733 ms | 524 / 804 / 910 ms |
| Tile offer p50 / p95 / max | 180 / 1,546 / 2,403 ms | 14 / 646 / 851 ms |
| Paint report p50 / p95 / max | 63 / 312 / 443 ms | 34 / 176 / 358 ms |
| Presence delivery p50 / p99 | 227 / 512 ms | 196 / 413 ms |
| Backend CPU, percent of one core | 96.2% | 65.5% |
| Backend RSS, median / peak | 184 / 189 MiB | 239 / 259 MiB |
| Full-stack CPU, percent of one core | 152.5% | 107.7% |
| Full-stack RSS, median / peak | 641 / 663 MiB | 635 / 684 MiB |
| CNPG containers CPU | 8.7% and 4.8% | 5.5% and 3.6% |
| MinIO CPU | 17.1% | 9.6% |

Full-stack resources sum the backend, frontend, two CNPG instances, and MinIO, as in the September report.
Before pooling, the passing Bun run used 69 percent of a core with upload p95 at 918 ms and paint p95 at 946 ms; the Bun lane now waits 57 ms at the median against Node's 455.
Bun also passed at 256 on run 7's and run 8's images, at 921 and 641 ms upload p95.

## Capacity ladder

With the shared processing fixed, the question was how many users one server sustains.
The trace size comes from `CAELESTIS_TEST_BENCHMARK_USERS` and the backend's 256-subscriber cap was raised to 2,048 through
`CAELESTIS_LIVE_SUBSCRIBER_LIMIT` for these runs only; presence already admits 2,048. Explorers stay at 70 percent of users.
Every rung is a strict run with the five-second deadline, on the same images, limits, and placement.
Passing rows report the measured phase; failing rows report the warmup burst up to the timeout, where every client connects and offers within seconds.

On the pooled images of run 10:

| Runtime | Users | Sockets | Result | Upload p95 | Paint p95 | Lane wait p50 / p99 | Backend CPU |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| Node | 256 | 512 | passed | 2,477 ms | 312 ms | 455 / 916 ms | 96.2% |
| Node | 384 | 768 | tile-upload timed out in warmup | 4,965 ms | 2,117 ms | 1,598 / 2,954 ms | — |
| Bun | 256 | 512 | passed | 804 ms | 176 ms | 57 / 405 ms | 65.5% |
| Bun | 384 | 768 | tile-offer timed out in warmup | 3,314 ms | 1,183 ms | 1,200 / 3,768 ms | — |

On the images before pooling (run 5's adapter, with `CAELESTIS_LIVE_SUBSCRIBER_LIMIT` added), every rung failed in the owned connection's queue:

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

Both Node runs at 192 drained warmup and finished the measured phase with every command inside the deadline, but the resource
collector then rejected a kubelet CPU window as insufficient and aborted before the final peer-set and draft checks, so they
are recorded as traffic passes rather than full passes.

The answer today is 256 users on both runtimes: Node passes with paint p99 at 0.4 seconds and Bun with 0.4 seconds against the 5-second deadline, and both fail at 384 in the warmup burst, waiting in the tile lane with no serialization retries and statements still at a millisecond.
Before pooling, Node's ceiling was 224 and Bun's 256 with 288 failing; the ladder was not rerun at 288 or 320 on the pooled images.

## Where the time goes

Backend stage timings from run 10, in milliseconds, with the last 512 samples per stage:

| Stage | Count | p50 | p99 |
| --- | ---: | ---: | ---: |
| `sql.statement` (execution on CNPG) | 35,310 | 1.1 | 5 |
| `sql.poolWait` (wait for a pooled session) | 19,071 | 0.0 | 6 |
| `sql.transaction` (wait for a lane turn) | 3,132 | 455 | 916 |
| `sql.retry` (aborted attempts) | 0 | — | — |
| upload `targets` (one indexed select) | 968 | 3.0 | 201 |
| upload `reserve` | 484 | 485 | 1,453 |
| upload `commit` | 484 | 487 | 1,203 |
| upload total | 484 | 1,067 | 2,559 |
| offer `reserve` | 1,371 | 423 | 871 |
| offer `commit` | 887 | 523 | 1,434 |
| paint `counters` | 244 | 18.5 | 260 |
| paint total | 244 | 48 | 408 |

A pooled session is available at once and a statement still executes in about a millisecond; CNPG stays below nine percent of a core.
What remains is the tile lane: 3,132 reservations and commits took turns during the 60 measured seconds, about 20 milliseconds each on Node, so the lane was busy for nearly the whole window and a turn waited 455 ms at the median.
A reservation is four round trips and a commit up to ten, and on Node each round trip costs several milliseconds of event-loop latency at 96 percent CPU rather than the millisecond the database takes.
Paint reports, which do not enter the lane any more, answer in 48 ms at the median instead of 2.9 seconds on run 5.

Two 20-second inspector profiles were taken in observe mode on runs 3 and 4 and are excluded from resource comparisons.
The first attributed 20.1 percent of samples to `structuredClone` under the Node live host's attachment reads.
The second showed 62.7 percent idle, `writev` at 5.8 percent, canvas decoding at 4 percent, and nothing else above 1.1 percent.

## The adapter now

`apps/backend/src/adapters/node/postgres-connection.ts` claims the ownership advisory lock on one pooled client at startup, as before.
Every other pooled session takes a shared advisory lock on a second key the first time it carries application work, then verifies that a backend carrying this process's owner name still holds the ownership lock; the database releases that lock the moment the owner backend dies, possibly before the process hears of it, and this check keeps a session opened after that moment from joining a database another owner has since drained and taken.
A replacement owner takes the ownership lock once the old owner session is gone, then must obtain the session key exclusively before it serves, which the database grants only after every session of the old process has closed, bounded by the statement timeout.
Losing the owner session ends this process's pool at once, so no query of a former owner can commit after a replacement starts writing.
This is stricter fencing than the single session gave: a takeover waits for every connection of the old process, not just its owner.

Reads and single statements run concurrently on the pool.
Transactions are SERIALIZABLE, as they were, and transactions that read and write the same small tables abort each other whatever rows they touch, because the planner scans a small table whole and a whole-table read conflicts with any concurrent write.
Every batch on a table a tile commit reads or writes therefore takes turns in one lane, as those writes effectively did on the single session; the coordinator's callback transactions, on their own tables, take turns in another; painters and telemetry overlap.
A serialization failure is retried up to ten times with a jittered backoff, and a commit that exhausts its retries is answered to the client as `unavailable` for the userscript to retry, never dropped.
Run 10 recorded no retries. The MariaDB adapter is unchanged and still runs on its owned session.

The strict run now passes on both runtimes, and the remaining cost sits in the Node event loop, at 96 percent of one core against Bun's 66, rather than in the database or the fence.
If more headroom on Node is wanted later, the lane's round trips could leave the busy event loop, on a worker thread with its own session, or a commit could be folded into fewer statements.

## Evidence and cleanup

The [compact results](benchmarks/tile-processing-cnpg-s3-2026-09-18.json) hold sent and received counts, latencies, stage timings, correctness, measured-phase resources, profile summaries, and container CPU for every run; `scripts/runtime-benchmark/compact-report.mjs` produces an entry from a raw report.
Raw reports, samples, and both `.cpuprofile` files remain under `~/Caelestis-397/test-results` on the devbox.
Two runs before run 2 failed to provision because both nodes had fallen under Longhorn's 25 percent free-space floor; unused container images were pruned on both nodes through `kubectl debug`, nothing else was touched.
All test namespaces, volumes, and imported image references were removed after the last run.
