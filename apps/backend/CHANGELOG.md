# @caelestis/backend

## 0.6.0

### Minor Changes

- d3aba73: Run Caelestis outside Cloudflare with PostgreSQL/CNPG or SQLite, S3 or local files, persistent live coordination, and Docker/Helm deployment.

### Patch Changes

- 2a24e1e: Expire region claims after 30 days without an authenticated owner connection and prevent expired local claims from replaying.
- 72fd83a: Start the portable server with Docker Compose using persistent local storage and an example environment file.
- f963558: Add an optional Cloudflare Tunnel container for testing Docker stacks over HTTPS without port forwarding.
- 0a17f5d: Restore fresh S3 test stack installs by fetching the pinned MinIO image from its official Quay registry.
- 48ce024: Store backend data and durable jobs in MariaDB with verified migrations, TLS connections, and one active server owner.
- 3098139: Preserve region claims, live presence, and multipart paint reports on self-hosted servers.
- 2f917dd: Keep published template progress visible in PostgreSQL live updates.
- 2e51d02: Share viewports and drafts with every connected server and show each nearby painter session once.
- 57ba6c0: Deploy the backend and frontend as separate containers with Compose examples for PostgreSQL, CNPG, and S3 storage.

## 0.5.0

### Minor Changes

- 3053415: Add the live painter presence socket at `/telemetry/presence`, its headcount at `/telemetry/presence/online`, and persisted region claims with raster shapes under `/work/regions`.

### Patch Changes

- 116a65d: Report large paint batches completely without losing activity or double-counting retries.

## 0.4.3

### Patch Changes

- 6021b80: Add caelest.is and backend.caelest.is alongside the existing Caelestis domains.

## 0.4.2

### Patch Changes

- af91052: Stop Eralyon backfill at the first native observation and give native history precedence in charts and timelapses.

## 0.4.1

### Patch Changes

- 5140200: Keep historical progress tied to saved canvas observations instead of recalculating it from current totals and placement reports.

## 0.4.0

### Minor Changes

- 0e5d506: Backfill sparse template timelapse and progress history from Eralyon archives through a userscript admin form.

### Patch Changes

- d6a978d: Attribute backfill D1 queries to their originating requests, including failed operations.
- 10ae980: Keep backfill starts retryable after alarm scheduling failures.

## 0.3.0

### Minor Changes

- e1dd180: Keep each painter's share of every folded telemetry bucket and serve it from `GET /telemetry/painter-history`, so dashboards can draw a painter's pace at the template's precision.
- 51ad3ba: Create, manage, and search tags on local and server folders.
- 1e0b8cb: Create, manage, and search reusable tags for local and server templates.
- 526dda5: Plan and claim shared work under folders and templates, with painter assignments, tags, blockers, live updates, and activity history.

### Patch Changes

- 9d87af0: Claim templates from their context menu and browse active work below the template list.
- 2c54c30: Let multiple painters claim a template independently, with admin assignment and personal release.

## 0.2.0

### Minor Changes

- d277ef2: Accept paint reports and tile uploads over authenticated WebSockets while preserving protocol v1 compatibility.

### Patch Changes

- 836886e: Schedule alarm follow-ups and refresh live alerts after WebSocket tile uploads.

## 0.1.0

### Minor Changes

- c1ac9b5: Establish backend release versioning.
