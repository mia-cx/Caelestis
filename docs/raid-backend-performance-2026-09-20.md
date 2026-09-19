# Backend raid measurements

These runs use the production Node host and shared coordinators on an isolated devbox clone.
Node 22.23.2 and Bun 1.4.2 use local PostgreSQL 18 and filesystem object storage.
The driver uses CPUs 0–1, backend 2–3, and database 4–5 on an AMD Ryzen 9 7950X host.
They do not measure CNPG, S3, ingress TLS or a production deployment.

## Workload and correctness (#474)

The deterministic raid trace keeps the existing viewport, draft, tile and paint workload.
It adds complex claims, legitimate edits, unchanged reconciliation, deletion, fresh-ID creation and presence reconnects.
At 256 users, 77 initial claims contain 22,099 document bytes. Twelve painters mutate one claim each every four seconds.
The four-step cycle edits, reconciles, deletes, then creates a new ID. Two explorers reconnect every 30 seconds.
Initial joins also exercise the full 256-client cohort. Ten-user samples use at least 37 claims.

Each run has 35 seconds of warmup and 60 measured seconds. Resource and application stage counters reset after
warmup commands drain. The measured trace starts from that boundary, avoiding a catch-up burst.
Stage durations are elapsed wall time; backend and database CPU come from process/container counters.
The existing `sql.transaction` metric measures queue wait, not SQL execution.

Every mutation waits for all clients to observe the matching document and credential-specific ownership within
five seconds. Final assertions check exact claims, owners, peers, drafts, paint totals and duplicate rejection.
The normal 256-user runs record 243 paint events and 7,290 painted pixels across warmup and measurement.
They keep the five-second command deadline and 300 ms presence cadence. No admission override is needed at 256.

`BENCH_DROP_CLAIMS=1` deliberately drops region updates for client 0. The
[fault-check result](benchmarks/raid-backend-fault-2026-09-20.json.gz) records a claim delivery timeout and a nonzero
benchmark exit. This verifies that a stale client cannot pass merely because the HTTP mutation succeeded.

Run one build, or three alternating build pairs:

```sh
BUN_BINARY=/path/to/bun BENCH_SCENARIO=raid BENCH_USERS=256 BENCH_VARIANTS=node,bun-compat \
  taskset -c 0,1 node scripts/runtime-benchmark/run.mjs test-results/raid

BUN_BINARY=/path/to/bun taskset -c 0,1 node scripts/runtime-benchmark/compare-builds.mjs \
  backend apps/backend/dist-baseline apps/backend/dist-candidate test-results/raid-pairs
```

Frozen compiled directories keep each comparison independent. Reports include compiled JavaScript hashes,
benchmark source hashes, trace/fixture hashes, runtime versions, placement, raw latency distributions and correctness.
The source revision is cb7e687 plus the specified uncommitted candidate; compiled hashes identify the measured artifacts.
`BENCH_SCENARIO=stable` retains the quiet-claim control.

The ten-user raid also passes on the production Worker/Durable Object adapters in local Miniflare,
with 37 initial complex claims, edits, reconnects and exact accounting. Its final state has 34 claims,
nine paint events and 270 pixels, with no deadline misses. Presence timings use a collector owned by
the room and an explicit RPC, so the admin endpoint does not read another isolate's empty clock.
The endpoint labels its season/world room. This is emulation and correctness evidence, not a Workers capacity claim.
[Raw Worker replay](benchmarks/raid-backend-miniflare-2026-09-20.json.gz) includes the observed stage counters.

### Instrumentation overhead

A supporting recovery benchmark compares compiled cb7e687 with f002a346, which adds presence instrumentation
before the backend optimizations. It uses the actual coordinator and SQLite on Mac Node 24.20.0, with
256 restored sockets, one warmup and five samples per variant, three alternating pairs at each claim count.
Both variants perform the same ownership reads and pass exact credential/anonymous ownership checks.

| Claims | Pair medians without timing | Pair medians with timing |
| --- | --- | --- |
| 37 | 25.131 / 25.686 / 25.149 ms | 25.648 / 25.393 / 25.214 ms |
| 512 | 142.655 / 146.647 / 142.623 ms | 145.331 / 148.313 / 142.950 ms |

The larger case averages 1.1% more recovery wall time with instrumentation. The smaller case varies in both directions.
This measures recovery preparation, not socket delivery or total deployed raid overhead. Existing SQL timings
remain enabled in both builds. The later tile-lane diagnostic counters are outside this comparison.
[Raw overhead samples](benchmarks/raid-backend-instrumentation-2026-09-20.json.gz) include CPU time and compiled coordinator hashes.

```sh
node scripts/runtime-benchmark/recovery.mjs \
  path/to/cb7e687/dist path/to/f002a346/dist test-results/instrumentation-recovery.json
```

## Peer selection (#475)

The baseline adds timing to cb7e687. The candidate removes temporary rectangle/result arrays from peer selection
and skips selection on quiet heartbeat ticks. Movement, membership changes and recovery still recompute every recipient.
Exact interest intersection, distance ordering, session-ID tie order and the 64-peer cap remain unchanged.
The primary metric is peer-selection task time. Total backend CPU is the secondary resource metric.

| Pair | Node selection, baseline → candidate | Bun selection, baseline → candidate |
| --- | --- | --- |
| 1 | 1.815 → 1.005 s | 1.922 → 0.810 s |
| 2 | 2.011 → 1.132 s | 2.023 → 0.831 s |
| 3 | 1.892 → 1.021 s | 2.078 → 0.800 s |

Selection time falls 44.8% on Node and 59.5% on Bun. Total backend CPU improves in all pairs,
by 8.6% on Node and 17.0% on Bun on average. Node CPU is 13.812/15.285/14.662 seconds before,
and 12.669/14.530/12.813 after. Bun is 12.375/12.661/12.832 before, and 10.351/10.570/10.498 after.
Presence delivery p95 stays around 295–303 ms. Claim mutation latency and bytes do not consistently improve.
All twelve runs pass correctness with zero command deadline misses.

[Raw comparisons](benchmarks/raid-backend-475-2026-09-20.json.gz) retain the noisy second Node pair and all secondary metrics.
Local filesystem results establish this local CPU improvement only. They make no CNPG/S3 capacity claim.

## Claim publication (#476)

The baseline includes #475. The candidate serializes public claims once per publication and groups owners
by both credential and actor. Each recipient skips a message only when public claims and its ownership are unchanged.
Every publication still reads committed claims and owners inside the revocation fence. Disconnects clear delivery state.

| Pair | Node CPU, baseline → candidate | Bun CPU, baseline → candidate |
| --- | --- | --- |
| 1 | 12.886 → 9.191 s | 10.255 → 8.293 s |
| 2 | 13.010 → 8.901 s | 10.341 → 8.483 s |
| 3 | 12.817 → 9.067 s | 10.176 → 8.543 s |

Mean CPU falls 29.9% on Node and 17.7% on Bun. Claim serialization falls from 3.685–3.719 to
0.058–0.060 seconds on Node, and 2.042–2.128 to 0.064–0.066 seconds on Bun.
Claim message bytes fall from 2,056,788,900 to 1,487,567,584 in every run, a 27.7% reduction.
Unchanged-claim request latency p95 also improves in every pair. Changed-claim delivery does not consistently improve.
All twelve runs preserve final claims, credential ownership, peer sets, drafts, 243 paint events and 7,290 pixels.
There are no command deadline misses. A focused test transfers ownership without changing public geometry
and verifies the old credential loses its claim IDs.
[Raw comparisons](benchmarks/raid-backend-476-2026-09-20.json.gz) include stage timings, bytes and correctness.
