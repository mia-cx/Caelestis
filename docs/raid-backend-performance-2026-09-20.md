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
`BENCH_SCENARIO=stable` retains the quiet-claim control. Instrumentation overhead and Workers verification remain pending.
