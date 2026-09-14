# #390 Bun runtime images

## Summary

Ship a pinned Bun backend alongside the Node backend. Prefer native Bun APIs while preserving portable contracts.
Keep Node as the default image and frontend runtime.

## Acceptance criteria

- [x] Bun starts the production backend and preserves HTTP, WebSocket, ownership, health, and shutdown contracts.
- [x] Tested amd64 and arm64 Node/Bun variants retain revision checks, SBOMs, scans, and the default Node tag.
- [x] Both runtimes pass all database/storage combinations, migrations, persistence, and recovery checks.
- [x] Compose and Helm select runtimes by image, with installation, upgrade, and rollback documentation.
- [x] Bun passes isolated k3s CNPG/S3 acceptance through Traefik, including frontend interoperability.
- [x] Corrected 256-user benchmarks compare Node/Bun on CNPG/S3 and separate backend/full-stack resources, recording failed capacity honestly.

## TODOs

- [x] Add the pinned Bun production image and validate packaged runtime compatibility.
- [x] Extend tested-image CI and release publication with versioned Node/Bun variants.
- [x] Implement native Bun HTTP and WebSocket transport with shared contract tests.
- [x] Use native Bun data APIs where they satisfy database and object-storage contracts.
- [x] Document runtime selection and verify Compose and Helm recovery across adapters.
- [x] Add matched production-image benchmarking and record k3s acceptance and 256-user results.
- [ ] Complete repository checks and prepare the pull request.

## Notes

- Base is main at 202fc171. Retain the harness branch `t3code/cloud-independent-adapters` after PR351 merged.
- Bun 1.4.2 locally supports DatabaseSync, columns, and setReturnArrays. Its pinned Debian image includes amd64 and arm64.
- Mia requested Bun-native APIs after the initial compatibility image. Native HTTP/WebSockets and data APIs are now in scope. Frontend migration, Miniflare production images, and sharding remain outside scope.
- All live tests use fresh isolated resources and the existing cleanup inventory. PR351's test stack is already removed.
- Benchmark warmup must drain pending commands before sampling. Historical results are approximate and do not establish production parity.
- TODO 1: Built Bun and Node frontend images. Bun SQLite/filesystem Compose acceptance passed with Box Art, packaged social worker, competing owner rejection, crash restart, and migrations. Existing SQLite/HTTP/WebSocket unit contracts passed on Bun.
- Bun backend suite passed 826 tests, with ten external-service tests skipped; the remaining ownership test discarded its lock handle. Retaining its release callback matches production ownership and fixes the test on Bun. The focused ownership test then passed.
- Bun replaces the Node executable with a Bun symlink inside the backend variant, so existing chart/Compose migration and S3 helper commands select Bun too. The frontend retains Node. Both variants share the same Debian/application layers.
- TODO 2: CI builds/scans/archives three images, runs both backend runtimes through Compose and Helm, and verifies executable versions against labels. Publication retains tested image identities and adds Node/Bun tags, SBOMs, digests, and runtime metadata. Release-version tests (2) and actionlint 1.7.12 passed.
- TODO 3: Bun.serve now handles HTTP and native WebSockets. Both transports share HTTP routing and bounded coordinator queues. The Bun backend suite passed 827 tests (10 service-dependent skips), Node/native Bun transport tests passed, and backend check/build passed. The native image passed SQLite/filesystem Compose acceptance. SQLite/S3 did not start because Quay returned 504 twice; retry during storage validation. Pinned dependency pulls now reuse cached digests.
- Bun types compile separately because their ambient fetch/Request declarations conflict with Cloudflare types. The separate Node frontend remains the supported Bun deployment pairing.
- TODO 4: Native bun:sqlite uses cached statements through the same SQLite migration/transaction adapter. Bun passed all 1,036 backend tests with PostgreSQL and MariaDB enabled. Node's focused SQLite/server tests and separate TypeScript checks also pass.
- Mia requires runtime differences behind adapters with one canonical server implementation. An isolated Bun.SQL trial passed its 12 narrow driver tests but failed 16/432 full contracts: JSON parameters double-encoded, DECIMAL/NUMERIC results became strings, and error identifiers differed. The API exposes no result-column type metadata for safe generic normalization. Keep pg/mariadb drivers; trial evidence is in test-results/bun-sql-exploration. See https://bun.com/docs/runtime/sql and https://github.com/oven-sh/bun/issues/28819.
- Bun 1.4.2 S3 options lack custom metadata and conditional PUT headers. Keep the shared AWS SDK adapter so ifAbsent remains atomic and object metadata survives Node/Bun switches. Filesystem atomic rename/link/fsync and worker_threads use Bun's implementations of the existing APIs. See https://bun.com/docs/runtime/s3 and the pinned bun-types/s3.d.ts.
- TODO 5: Node passed all six extended Compose combinations. All six Node-to-Bun upgrades preserved Box Art, data, and object metadata, with crash/database recovery and migrations. Evidence is under test-results/issue390-{node,bun}-compose. The packaged worker check now runs after an upgrade so it exercises the selected runtime.
- Bun passed SQLite/filesystem, CNPG/S3, and MariaDB/S3 on k3s through Traefik HTTPS/WSS. Each covered pod replacement and standalone migrations; CNPG primary switchover and MariaDB connection loss recovered ownership. Cleanup inventories verify namespace, PV, and Longhorn deletion.
- Runtime selection, matching frontend images, pinned digests, installation, and rollback are documented. Startup scripts use the repository root so packaged social rendering resolves correctly. Helm lint/render, stack helper tests (5), lint, check, and build passed. Both runtimes passed all 1,036 backend and 16 storage contracts. The userscript suite passed 1,509 tests with two workers after six parallel-run timeouts.
- Extended native amd64/arm64 CI started at 795cde0e: https://github.com/mia-riezebos/Caelestis/actions/runs/34885313474. Publication is configured but no release is published during this task.
- Populating the packaged social-worker smoke test exposed different CommonJS default exports in Node and Bun. Selecting gifenc's ESM build fixes both without a runtime branch. Both runtimes pass all 13 real social-image tests; three mocked frontend tests also pass. CI now runs the real tests under Bun, and the container test renders after seeding/upgrading. Rebuild final images for the benchmark and repeat the populated container check.
- Final application revision c5b3c4d5 passed extended CI: https://github.com/mia-riezebos/Caelestis/actions/runs/34885853405. Native amd64/arm64 builds, 24 Compose cases, six Helm cases, scans/SBOMs, runtime contracts, and local Workers checks passed. The earlier run was cancelled after the social fix to test the final revision.
- Final local images at c5b3c4d5 passed all six populated Node-to-Bun upgrades. Backend and renderer file manifests match exactly across the Node/Bun images (SHA256 92cb7097363200f5ef7cfb46df1192b993031c62bbbcfea8ad4f70d84549a155). All 172 frontend tests, lint, check, and the Cloudflare frontend build pass after the ESM import change.
- The first k3s benchmark attempt lacked two fresh kubelet snapshots and masked the underlying workload failure. Cleanup completed; that run is excluded. The collector now saves raw diagnostics before validation, preserves workload errors, and rejects missing/reset counters. Failed warmup resources are reported separately when sufficient samples exist.
- Strict final-image Node and Bun runs both exceed the userscript's five-second tile-upload deadline at 256 users on CNPG/S3. All 512 sockets remain connected, but neither reaches final correctness checks. Separate 30-second observation runs retain deadline failures and measure failed warmup resources; they do not establish production capacity or a latency winner.
- Shared capacity work is tracked in https://github.com/mia-riezebos/Caelestis/issues/397. A separate, excluded Node profile attributes 35.5% of samples to classifyTarget and 10.2% to encodeMismatchMask. Repeated successful comparisons are deferred until that failure is fixed; no shared business-logic changes or relaxed production deadlines are included here.
- TODO 6: The final unprofiled Node/Bun observation pair also fails during warmup. Backend CPU is 106.58%/98.62% of one core; median RSS is 210.69/287.48 MiB. Full-stack CPU is 136.69%/133.39%, with median RSS 563.57/731.24 MiB. Different completed work and drain durations prevent an efficiency ranking. Report and compact provenance/results are in docs/bun-runtime-validation-2026-09-14.md and docs/benchmarks/bun-cnpg-s3-2026-09-14.json. All load-test namespaces and backing volumes are cleaned. Eight benchmark/cleanup tests, actionlint, lint, check, and build pass.
