# k3s validation, 14 September 2026

All six database/storage combinations passed on Mia's existing two-node amd64 k3s cluster,
using the original PR application sources at `58b9e59d`.
Each run used an isolated namespace, the existing CNPG operator, and dedicated Longhorn volumes.

| Database | Storage | Acceptance | Recovery and migration | Cleanup |
| --- | --- | --- | --- | --- |
| SQLite | Filesystem | Passed | Passed | Verified |
| SQLite | S3 | Passed | Passed | Verified |
| CNPG | Filesystem | Passed | Passed, including primary switchover | Verified |
| CNPG | S3 | Passed | Passed, including primary switchover | Retained for Mia |
| MariaDB | Filesystem | Passed | Passed, including connection loss | Verified |
| MariaDB | S3 | Passed | Passed, including connection loss | Verified |

Every stack passed HTTP, SSR, authorization, object bytes, authenticated/public WebSockets,
event deduplication, reconciliation, pod replacement, and migration checks. Both relational
database adapters used verified TLS. Each stack imported Box Art and retained its geometry
and all eight chunk hashes after each lifecycle check.

The retained stack also passed the shared acceptance suite through its public Traefik HTTPS origin.
The served userscript and Box Art download matched the local files by SHA-256.
Mia confirmed the connection works from her work laptop. Rendering, painting, reconnection,
and administration checks remain with Mia. Previous-release upgrades were outside this run.

## Retained browser test stack

- Website: the stack's public Traefik HTTPS origin.
- Userscript server: the same origin under `/backend`.
- PR userscript: served from `/test-assets/caelestis.user.js` on that origin.
- Import fixture: served from `/test-assets/box-art.wplace` on that origin.
- Namespace: `caelestis-test-cnpg-s3-mu15pdnl`, context `default`.
- Box Art is already published at canvas origin `(325051, 1781650)`, size `1612 × 2584`.

The bootstrap admin and reporting tokens were delivered privately to Mia in the task conversation.
Their local copy is `test-results/caelestis-test-cnpg-s3-mu15pdnl/credentials.json`, mode `0600`.
The frontend's internal read token stays server-side.

1. Open the website and check Box Art's preview, dimensions, and progress.
2. Load the PR userscript in Chromium and connect to the userscript server with the reporting token.
3. Show Box Art on Wplace. Hide the original Caelestis server and Local group to check this server's overlay alone.
4. Paint a pixel and check live progress/painter updates. Reload Wplace and verify reconnection and retained state.
5. Use the admin token to import a disposable template, rename it, toggle publication, and delete it.

Mia requested this stack stay running until she finishes browser testing.
The two database pods, MinIO, application pod, and static download pod remain available.
The completed bucket-creation job and all image-transfer pods have been removed.

## Evidence and cleanup

Per-run results, redacted logs, and exact ownership inventories are in `test-results/caelestis-test-*`.
`traefik-result.json` in the retained run records public proxy validation.
All five disposable namespaces, their PVCs/PVs, and their Longhorn backing volumes were removed.
Existing workloads, shared operators, CRDs, and storage classes were preserved.

After Mia finishes browser testing:

```sh
node scripts/stack-tests/kubernetes-run.mjs test-results/caelestis-test-cnpg-s3-mu15pdnl/inventory.json
node scripts/stack-tests/k3s-images.mjs remove default test-results/k3s-images-restack-1444f512
```

The first command verifies namespace and storage deletion and removes the private credentials file.
The second removes only the recorded test image references from both nodes, then removes its temporary pods.

The original image identities are recorded in `test-results/k3s-images/images.json`:

- Backend: `sha256:8e9420297fd556ddfaed06ac0e0575ea1a663ada425a781f75d2e97f3b81653b`
- Frontend: `sha256:e5c7656e4a816afb7269f6b1606833a8dab3fbbd100995bafdb17c38a82586fe`

The driver now supports explicit existing-cluster contexts, six storage/database combinations,
Box Art lifecycle checks, fresh credentials, optional Traefik access, and resumable cleanup.
Four focused tests cover cluster/namespace ownership guards and already-completed cleanup.
Biome, JavaScript syntax checks, and those four tests pass.

## Restack onto main

PR #351 was rebased onto `main` at `eb92ef84` without conflicts and pushed at `1444f512`.
This includes userscript v0.12.0, the newer Painters drawer, viewport navigation, collaboration
rendering changes, and shortcut rebinding.

Workspace typechecks passed. Backend, frontend, and userscript suites passed 2,484 tests;
10 database-specific backend tests were skipped without their local service configuration.

The retained CNPG/S3 stack was upgraded in place using images built from `1444f512`.
Its server identity, existing Box Art template and chunks, and both delivered tokens survived.
The userscript download at the same URL now serves v0.12.0 from the rebased checkout.

After upgrading, the shared acceptance suite passed through public Traefik HTTPS again.
A separate two-client WSS probe passed remote viewport delivery, draft masks, claim creation/deletion
broadcasts, credential ownership, interest-area removal, and claim recovery on client reconnection.
This validates one server. Cross-server routing remains tracked separately in
[#383](https://github.com/mia-riezebos/Caelestis/issues/383).

The six-stack matrix above belongs to the original image build. The post-rebase validation covers
the retained CNPG/S3 stack, the public proxy, and the local application suites.

Current image identities, recorded in `test-results/k3s-images-restack-1444f512/images.json`:

- Backend: `sha256:30d4ae09e7466b860f1296a0961c9cb2e3c5b66fadc100381045743b9c9d6702`
- Frontend: `sha256:865f871fa7f7e82d5b0510bafda36c5bacc91b215d46c145181182d1a393ab13`

The image loader needed more than its original 256 MiB limit on the second node.
Its limit is now 512 MiB, and retries verify existing image digests before reusing them.
Transfers have a bounded deadline and close both subprocesses on failure.
