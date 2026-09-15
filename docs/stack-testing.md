# Stack tests

Regular pull requests need no credentials, Cloudflare account, Docker Hub login, or Kubernetes cluster.
GitHub provides the runners. Each Kubernetes test creates its own kind cluster and private kubeconfig.

| Run | Coverage |
| --- | --- |
| Every PR and main push | Local Cloudflare Workers; six amd64 Compose combinations per backend runtime; Node/Bun Helm with SQLite/filesystem, CNPG/S3, and MariaDB/S3; adapter contracts; image scans; chart schemas |
| Nightly and extended manual runs | The same checks, plus all six ARM64 Compose combinations per runtime, previous-version upgrades, database connection-loss recovery, and CNPG primary switchover |
| Nightly Cloudflare run | A real, isolated D1/R2/Durable Object deployment, shared acceptance tests, backend redeployment, and cleanup |
| Portable release | Extended checks and live Cloudflare must pass before publishing the tested images |

The shared suite in `scripts/stack-tests/acceptance.mjs` checks authenticated HTTP, frontend SSR, template creation and updates, exact chunk bytes, tile uploads, WebSocket paint reports, duplicate rejection, read-only WebSocket permissions, and live reconciliation. It repeats reads and duplicate reports after restart, pod replacement, or migration. Deleting a template retains shared chunks by design.

Compose also runs the packaged social renderer, rejects a competing backend owner, and kills the backend without a graceful flush. Kubernetes tests use the shipped chart and example values, including real CNPG-generated credentials and verified TLS. MariaDB's Kubernetes fixture also requires verified TLS. Adapter tests retain their separate coverage of storage metadata, conditional writes, deletion, transactions, deadlines, and recovery.

Each matrix job runs independently with `fail-fast: false`. Logs and results stay in Actions artifacts for seven days. The `stack-tests` job fails if any required job fails, gets cancelled, or is unexpectedly skipped. A missing database service is a failure.

## One-time account setup

Run from this checkout:

```sh
bash scripts/setup-stack-ci.sh
```

The wizard opens the relevant pages and saves each value. It needs `gh auth login` with repository administration access.

1. Choose a Cloudflare account with Workers, a workers.dev subdomain, and R2 enabled. Copy its Account ID.
2. Create a dedicated Cloudflare token with Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, and Account Settings Read. Scope it to that account.
3. Create the public Docker Hub repositories `miacx/caelestis-backend` and `miacx/caelestis-frontend`. Create a Docker personal access token with Read and Write permissions.

The wizard writes the following configuration:

| Value | Destination |
| --- | --- |
| `CLOUDFLARE_TEST_ACCOUNT_ID` | GitHub repository variable |
| `CLOUDFLARE_TEST_API_TOKEN` | GitHub `stack-tests` environment secret |
| `DOCKERHUB_TOKEN` | GitHub repository secret |

It also keeps a private, git-ignored `.env.stack-ci` file for reruns. The test environment permits only `main` and has no reviewer or wait-time gate. The existing production Cloudflare token is separate.

Cloudflare documents [token creation](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) and [workers.dev configuration](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/). Docker documents [personal access tokens](https://docs.docker.com/security/access-tokens/personal-access-tokens/).

After this PR merges, enable the required check and run both full workflows:

```sh
node scripts/enable-stack-ci-gate.mjs
gh workflow run portable-ci.yml --ref main -f extended=true
gh workflow run portable-cloudflare.yml --ref main
```

The gate script adds one ruleset without replacing other branch rules. It refuses to run before `main` contains the check. These commands can be run by an agent with the same GitHub access.

## Cloudflare isolation and cleanup

The live suite reserves the D1 database and R2 bucket `caelestis-stack-ci`, plus Workers with that prefix. Use these names only for the suite. It replaces all production resource IDs and routes before deploying. Test data goes through workers.dev URLs and service bindings.

All live runs share one concurrency group. Cleanup runs before provisioning and in `finally`; the next successful scheduled run also cleans up resources left by an interrupted runner. The cleaner empties only the reserved bucket before deleting it. Missing account setup fails the live job with the setup-document path. A PR never receives the Cloudflare secret.

## Upgrades and release artifacts

Extended runs select the latest earlier portable release and verify its image-manifest checksums. Until one exists, they build commit `6884c40704b63c75e8ed0549860df348db325600`, the initial portable baseline. They seed the old application, stop it, run candidate migrations, then verify the candidate against the preserved data. Cross-adapter export/import tests belong to the future portability feature.

Each architecture builds the Node backend, Bun backend, and Node frontend once. Jobs consume checksummed archives. Publication loads those same archives, verifies image IDs, architecture and source revision, then pushes them without rebuilding. The release includes per-architecture image configurations, SBOMs, image digests, runtime versions, and the chart pinned to the default Bun backend and Node frontend.

## Run locally

Docker Desktop must be running. Build the images, then select one combination or run all six:

```sh
docker build --target backend -t caelestis-backend:test .
docker build --target frontend -t caelestis-frontend:test .
node scripts/test-portable-compose.mjs caelestis-backend:test caelestis-frontend:test postgres s3
node scripts/test-portable-image.mjs caelestis-backend:test caelestis-frontend:test
```

Build `--target backend-bun -t caelestis-backend-bun:test` and repeat with that backend image to test Bun.
The frontend remains the matching Node image. The populated social renderer runs after candidate migration during upgrades.

For Kubernetes, install kind, kubectl and Helm, then run:

```sh
node scripts/test-helm-stack.mjs caelestis-backend:test caelestis-frontend:test cnpg
```

For local Cloudflare, install workspace dependencies and build the frontend dependencies first:

```sh
pnpm install --frozen-lockfile
pnpm --filter @caelestis/frontend... build
node scripts/test-cloudflare-stack.mjs
```

Set `CAELESTIS_TEST_EXTENDED=true` for database-recovery checks. For local upgrade tests, run `node scripts/stack-tests/prepare-baseline.mjs arm64` (or `amd64`), then set `CAELESTIS_BASELINE_BACKEND_IMAGE=caelestis-backend:baseline` and `CAELESTIS_BASELINE_FRONTEND_IMAGE=caelestis-frontend:baseline` when running the Compose test. Each driver removes only its own temporary resources.

### Existing k3s cluster

Set `CAELESTIS_KUBE_CONTEXT` explicitly to use an existing cluster. The driver creates a unique test namespace,
reuses the installed CNPG operator, and uses the existing `longhorn-single` storage class with `Delete` reclamation.
It never creates or deletes the cluster, operators, CRDs, or storage classes.

Build the two images first. If no registry is available, the image helper loads them onto each node through
temporary pods with access to the k3s binary and containerd socket. This requires cluster administrator access.
The helper reuses existing references only when their digests match the recorded local images.
It refuses unverified replacements. Choose unique image tags for each run.
The helper records each node's containerd target after import and checks it again before removal.
Cleanup leaves retagged references untouched and reports them instead of claiming completion.
Older inventories without per-node targets require manual ownership verification before image cleanup.

```sh
node scripts/stack-tests/k3s-images.mjs import CONTEXT test-results/k3s-images BACKEND_IMAGE FRONTEND_IMAGE
CAELESTIS_KUBE_CONTEXT=CONTEXT CAELESTIS_TEST_STORAGE=filesystem \
  CAELESTIS_TEST_EXTENDED=true CAELESTIS_TEST_WPLACE=fixtures/stack-tests/box-art.wplace \
  node scripts/test-helm-stack.mjs BACKEND_IMAGE FRONTEND_IMAGE sqlite
```

Repeat with `sqlite`, `cnpg`, and `mariadb`, each with `filesystem` and `s3` storage.
The fixture checks compare Box Art's geometry and chunk hashes after pod replacement, migration,
and database recovery. Extended CNPG tests switch the primary of the dedicated test Cluster.
Extended MariaDB tests disconnect the application's own database sessions and verify backend recovery.

Each run saves results, redacted logs, and an ownership inventory under `test-results/caelestis-test-*`.
Cleanup removes the namespace, including retained Helm PVCs, and verifies PV and Longhorn volume deletion.
SIGINT and SIGTERM invoke the same cleanup. After an abrupt termination, resume cleanup with:

```sh
node scripts/stack-tests/kubernetes-run.mjs test-results/RUN/inventory.json
```

For manual browser testing, set `CAELESTIS_TEST_KEEP=true` and `CAELESTIS_TEST_ORIGIN=https://HOST`.
Only a passing stack is retained. The driver creates a Traefik IngressRoute using the existing default TLS
certificate and saves a bootstrap admin token and a separate reporting token in a private `credentials.json`.
DNS and certificate coverage must already exist for the hostname. The reusable manifest is
[`traefik-ingressroute.example.yaml`](../deploy/helm/traefik-ingressroute.example.yaml).

Setting only `CAELESTIS_TEST_ORIGIN` exercises HTTPS/WSS through Traefik after each recovery step and cleans up afterward.
For matched 256-user production-image measurements, see the [runtime benchmark instructions](../scripts/runtime-benchmark/README.md).

When browser testing finishes, run the namespace cleanup command above. Then remove the test image references:

```sh
node scripts/stack-tests/k3s-images.mjs remove CONTEXT test-results/k3s-images
```

Namespace cleanup also deletes the retained run's private `credentials.json`. Keep the redacted results and inventories.
