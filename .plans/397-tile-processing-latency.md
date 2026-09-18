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

- [ ] Replace the per-pixel Map and bit-packing loops in classification with typed-array kernels; prove byte-identical output.
- [ ] Share classification results across reporters with a bounded cache keyed by every classification input (#413).
- [ ] Skip the repeated S3 PUT for an already-active hash and load telemetry targets once per command.
- [ ] Move derived mismatch-artifact writes to a bounded background writer that drains on shutdown (#414).
- [ ] Record per-stage timings for live tile and paint commands in request metrics and the benchmark JSON.
- [ ] Add Changesets and run lint, check, test, and build on Node and Bun.
- [ ] Repeat the strict 256-user CNPG/S3 workload on Node and Bun and record the results under docs/.

## Notes

- Base is main at 2d51baff on harness branch `t3code/be2b8122`.
- Mia: address the parent together with its existing sub-issues; do not split it further. The five
  sub-issues I created by mistake (#438 to #442) are closed as not planned.
- Findings from reading the code are posted on #397. One accepted upload runs eleven serial steps
  before its reply; classification is on the event loop; offers acknowledged only after commit so
  many reporters upload one fresh hash; commits serialize on the season revision row under
  SERIALIZABLE with up to five retries; pool is ten connections for 512 sockets.
- The local kubeconfig has one context, `default`, at 10.0.128.1:6443. Reachability is checked
  before the benchmark TODO.
