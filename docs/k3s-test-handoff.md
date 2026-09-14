# k3s test handoff

Continue [PR #351](https://github.com/mia-riezebos/Caelestis/pull/351) on branch
`t3code/cloud-independent-adapters`. The devbox can access the user's k3s cluster.
Docker tests are complete; k3s tests have not started. All required code and the
Box Art fixture are on this branch. No archive or patch application is needed.

## Completed validation

SQLite, PostgreSQL, and MariaDB each passed with filesystem and S3 storage.
Every combination imported Box Art and verified its eight chunk hashes and
geometry after crash recovery and migration. Extended database connection-loss
checks also passed. Previous-release upgrades were not tested in this run.

The tested application images were built from `21e6b8dd503b415a91d6c29cffdd26535ed69ad9`.
Subsequent commits contain test/deployment configuration and this handoff.
The manual PostgreSQL/MinIO stack passed HTTPS, authentication, live WebSockets,
and painter-presence checks through a Cloudflare Tunnel. Chromium displayed its
Box Art with the original Caelestis server and Local group hidden locally.
The Mac stack and userscript watcher remain running for manual testing.

## Start here

1. Check out this PR branch and follow its AGENTS.md. Run `pnpm install --frozen-lockfile`.
2. Inspect the selected Kubernetes context, access, node architectures, storage
   classes/reclaim policies, and existing CNPG operator. Use an explicit context
   and a uniquely named test namespace. Preserve existing workloads.
3. Build both application images from this checkout and make them available to
   the cluster. See [self-hosting](self-hosting.md) for the Docker targets and chart.
   Generate fresh test secrets; Mac credentials and images are not included.
4. Adapt the existing Kubernetes test driver for this existing k3s cluster.
   `scripts/test-helm-stack.mjs` currently creates/deletes its own **kind** cluster,
   installs its own CNPG operator, and loads local images. Do not run it unchanged
   expecting to test k3s, or point its destructive lifecycle at the user's cluster.

## Test scope and reusable code

- Use `deploy/helm/caelestis/` and the CNPG/MariaDB examples beside it.
- Cover SQLite/filesystem, SQLite/S3, CNPG/filesystem, CNPG/S3,
  MariaDB/filesystem, and MariaDB/S3. Keep one active application backend owner.
- Reuse the existing CNPG operator with a dedicated test CNPG Cluster and volumes.
  Its backup object storage is not an application S3 endpoint. Provision separate
  test S3 storage. Use verified database TLS.
- Run `scripts/stack-tests/acceptance.mjs` for HTTP, SSR, authorization, object
  bytes, WebSocket reporting, idempotency, and reconciliation. See
  [stack testing](stack-testing.md) for the existing coverage and lifecycle checks.
- Import `fixtures/stack-tests/box-art.wplace` in every stack using `importWplace`
  from `scripts/stack-tests/wplace.mjs`. Repeat `verifyWplace` after pod replacement,
  migration, and database recovery. The Compose driver shows how to call both.
  The Helm driver does not yet call these helpers; wire them into the k3s tests.
- Exercise CNPG switchover only on the dedicated test database cluster.
  Verify application restart/reconnection and retained data afterward.
- If a graphical browser is available, verify rendering and userscript loading
  through Chromium debug CDP with a persistent focus-emulation session. Use the
  userscript dev injector, not Helium or browser-extension automation. Report any
  unavailable visual coverage separately from API results.

Box Art is 1612×2584 at canvas origin (325051, 1781650). To repeat Docker validation:

```sh
CAELESTIS_TEST_WPLACE=fixtures/stack-tests/box-art.wplace CAELESTIS_TEST_EXTENDED=true \
  node scripts/test-portable-image.mjs BACKEND_IMAGE FRONTEND_IMAGE
```

The MinIO references now use its official Quay registry with the same pinned
digest. Docker Hub rejected the old reference during the local test run.

## Mandatory cleanup

The user explicitly requires **all test pods and deployed manifests/resources
removed when testing finishes**, including failure and interruption. Existing
cluster resources must remain untouched.

Design cleanup before provisioning. Record each owned resource and register
cleanup in `finally`, SIGINT, and SIGTERM handlers. Support cleaning the exact
recorded run after an abrupt termination that bypassed those handlers.

- Save redacted logs, results, image identities, and the resource inventory outside
  the cluster before cleanup. Keep these evidence files.
- Stop test port-forwards/tunnels. Uninstall test Helm releases and remove owned
  workloads, pods, jobs, services, ingress/routes, ConfigMaps, Secrets, service
  accounts/RBAC, CNPG resources, PVCs, and test namespaces.
- **Helm uninstall alone is insufficient.** The chart's PVC has
  `helm.sh/resource-policy: keep`. Remove owned claims explicitly and verify
  retained PVs, backing storage, test buckets/objects, and backup resources are gone.
- Reuse shared operators, CRDs, and storage classes. Never delete them during
  cleanup. Track any unavoidable new cluster-scoped resource by exact identity.
- Verify namespace deletion and absence of every owned resource. `kubectl get all`
  misses PVCs, Secrets, and custom resources. Never run a cluster-wide delete or
  force-remove unknown finalizers. Diagnose and report any cleanup failure.
- Delete temporary generated secret files once no longer needed.

Completion requires both test results and verified cleanup. Leave no test pods,
deployed manifests, or orphaned test storage for the user to remove manually.
Do not merge the PR or deploy to production.

## Suggested skills

Call the Skill tool, or read the corresponding SKILL.md when unavailable:

- `address-issue` for continuing PR #351 implementation and validation.
- `diagnosing-bugs` for actual deployment/test failures.
- `wizard` only for unavoidable human-only setup; otherwise work autonomously.
- `codex-computer-use` for visual checks, following the explicit Chromium/CDP rule.
- `gh-comment` when publishing findings to the PR.

Load the response skills required by AGENTS.md. Use short, exact instructions for
any human step the devbox cannot perform. Report skipped checks accurately.
