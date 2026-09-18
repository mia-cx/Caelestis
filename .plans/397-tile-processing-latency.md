# #397 Reduce tile-processing latency at 256 users on CNPG/S3

## Summary

Both production runtimes miss the userscript's five-second live-command deadline at 256 users on
k3s with CNPG and S3. Find where tile uploads and paint reports spend time, remove shared
processing waste without changing claim, paint, status, ownership, or duplicate-delivery semantics,
and repeat the corrected 256-user workload on Node and Bun. Sub-issues #413 (share identical
in-flight classification) and #414 (flush reconstructible artifacts outside the reply path) are in
scope and land in the same branch.

## Acceptance criteria

- [ ] Identify where tile uploads and paint reports spend time: classification, database queueing, S3 requests.
- [ ] Fix shared processing without changing claim, paint, status, ownership, or duplicate-delivery semantics.
- [ ] #413: identical in-flight classification and mask generation is shared across reporters, bounded, every observation still recorded.
- [ ] #414: reconstructible mismatch artifacts no longer hold the live reply; bounded, drained on shutdown, lost work only causes cache misses.
- [ ] Repeat the corrected 256-user workload on both production runtimes with the same CNPG/S3 resources and placement.
- [ ] Verify exact persisted paints, deduplication, peer sets, drafts, recovery, and five-second client deadlines. Report backend and full-stack resources separately.

## TODOs

- [x] Replace the per-pixel Map and bit-packing loops in classification with typed-array kernels; prove byte-identical output.
- [x] Share classification results across reporters with a bounded cache keyed by every classification input (#413).
- [x] Skip the repeated S3 PUT for an already-active hash and load telemetry targets once per command.
- [x] Move derived mismatch-artifact writes to a bounded background writer that drains on shutdown (#414).
- [x] Record per-stage timings for live tile and paint commands in request metrics and the benchmark JSON.
- [x] Add Changesets and run lint, check, test, and build on Node and Bun.
- [ ] Repeat the strict 256-user CNPG/S3 workload on Node and Bun and record the results under docs/.

## Notes

- Base is main at 2d51baff on harness branch `t3code/be2b8122`.
- Mia: address the parent together with its existing sub-issues; do not split it further. The five
  sub-issues I created by mistake (#438 to #442) are closed as not planned.
- Findings from reading the code are posted on #397. One accepted upload runs eleven serial steps
  before its reply; classification is on the event loop; offers acknowledged only after commit so
  many reporters upload one fresh hash; commits serialize on the season revision row under
  SERIALIZABLE with up to five retries; pool is ten connections for 512 sockets.
- The local kubeconfig has one context, `default`, at 10.0.128.1:6443. Neither it nor ssh to
  hydra-olympus-1 (10.0.1.3) answers from this machine at 16:00 UTC. Retry before the benchmark TODO.
- TODO 1: `classifyChunk` keeps per-colour counts in one Uint32Array and hoists imported constants
  into locals; `encodeMismatchMask` builds each packed byte in a local. Under vitest a full
  1000×1000 chunk classifies in 5.2 ms + 1.0 ms encode on Node 24 and 5.3 + 1.3 ms on Bun 1.3.14,
  against 49 to 50 ms for the old Map loop in the same harness. Vitest's module transform turns
  imported constants into property reads, which is why the first version measured 35 ms; plain
  Node ran the same loop in 5 ms. 25 random rectangles match the old loop byte for byte.
- TODO 2: `sharedClassifier` reuses `DecodedPixelCache` (pending-promise coalescing, TTL, LRU by
  bytes) keyed by template, version, tile, chunk hash, and canvas hash. It holds counts, colours,
  and the packed mask; `observedAt` is stamped per observation afterwards so reporter, timestamp,
  history, alarms, and commit ordering are untouched. Null results are never retained and a
  rejected load is retried by the next caller. Bound: 32 MiB / 128 entries / 3 minutes. Four unit
  tests plus the 38 coordinator upload tests pass.
- TODO 3: `uploadTilePromise` reads the registered blob object after reserving and skips the PUT
  when that generation is already active under the reserved key; the reservation still fences GC.
  Offers and uploads pass their loaded targets into `recordObservationPromise`, removing one
  `listTelemetryTargets` round trip per command. `ingest.test.ts` uploads one hash from three
  reporters through the real D1-over-SQLite store: one tile PUT, three raw history frames.
- TODO 4: `derivedArtifactWriter` is one bounded queue per runtime (64 MiB, 256 entries, four
  concurrent writes) that coalesces a key already queued or in flight, drops the newest write on
  overflow with a counter, and reports failures without failing anything. Live paths create their
  artifact batch with the writer so `flush()` returns once writes are queued; the fetcher keeps
  awaiting its own batch. Node's runtime close drains for at most ten seconds; the Cloudflare
  Worker's `fetch` now takes its execution context and calls `waitUntil(drain())` so the isolate
  stays alive for queued writes. Durable Objects keep running pending promises without it.
- TODO 5: `IngestTimings` keeps count, total, max, p50, and p99 (last 512 samples) per command
  and stage in process. Uploads record queue wait (Node live host), hash, targets, reserve,
  blobPut, decode, prepare, classify, painter, commit, projection, alarms, artifacts, historyFold,
  and total; offers and paints their own stages. Counters record shared versus computed
  classifications and skipped blob PUTs. `GET /admin/server/ingest-timings` returns the snapshot
  and `?reset=true` clears it. The k3s benchmark driver resets before the trace and stores the
  snapshot as `result.backendStages`. Node has no request-metrics dataset, so the snapshot is the
  portable surface rather than a new Analytics Engine column.
- TODO 6: Three backend patch Changesets (shared classification and upload dedupe, background
  artifact writes, ingest-timings endpoint). `pnpm lint` passes with one pre-existing warning and
  two infos in untouched files; `pnpm check` 11/11; `pnpm build` 7/7. Backend on Node: 845 tests
  passed, 10 skipped (external services). Touched backend suites on Bun 1.3.14: 265 passed.
  Shared: 255 passed.
- TODO 7 is blocked from this machine: the k3s API at 10.0.128.1:6443 and ssh to hydra-olympus-1
  (10.0.1.3) both time out at 14:00 and 14:19 UTC. The driver change that records
  `backendStages` is in place, so the next run on the cluster produces the breakdown and the
  strict pass/fail without further code. The pull request uses `Refs #397` until that run.
