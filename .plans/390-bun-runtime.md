# #390 Bun runtime images

## Summary

Ship a pinned Bun backend alongside the Node backend. Prefer native Bun APIs while preserving portable contracts.
Keep Node as the default image and frontend runtime.

## Acceptance criteria

- [ ] Bun starts the production backend and preserves HTTP, WebSocket, ownership, health, and shutdown contracts.
- [ ] Tested amd64 and arm64 Node/Bun variants retain revision checks, SBOMs, scans, and the default Node tag.
- [ ] Both runtimes pass all database/storage combinations, migrations, persistence, and recovery checks.
- [ ] Compose and Helm select runtimes by image, with installation, upgrade, and rollback documentation.
- [ ] Bun passes isolated k3s CNPG/S3 acceptance through Traefik, including frontend interoperability.
- [ ] Corrected 256-user benchmarks compare Node/Bun on CNPG/S3 and separate backend/full-stack resources.

## TODOs

- [x] Add the pinned Bun production image and validate packaged runtime compatibility.
- [x] Extend tested-image CI and release publication with versioned Node/Bun variants.
- [x] Implement native Bun HTTP and WebSocket transport with shared contract tests.
- [ ] Use native Bun data APIs where they satisfy database and object-storage contracts.
- [ ] Document runtime selection and verify Compose and Helm recovery across adapters.
- [ ] Add matched production-image benchmarking and record k3s acceptance and 256-user results.
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
