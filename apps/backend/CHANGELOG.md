# @caelestis/backend

## 0.9.0

### Minor Changes

- 3a6fd56: Admins configure the server's public presentation: description, Discord invite, home page copy, logo text, and uploaded logo and link preview images.

### Patch Changes

- 1dbd5e7: Clear your claims from the Painters drawer with any write-capable token, without finding the original token.
- 509b396: Show denser retained timelapse snapshots with playback timing proportional to elapsed recorded time.
- 29817ac: Prevent deleted claims from returning during MariaDB READ COMMITTED transaction races.
- 6c96ce5: Expire legacy claims without repeating an expiry backfill before every claim operation.
- ec1f9cb: Serialize claim snapshots once per room and avoid sending unchanged claims and ownership twice.
- 6c96ce5: Reuse claim ownership reads while restoring a room's connected painters.
- fd227f6: Avoid resending unchanged claim snapshots when database ownership rows arrive in a different order.
- 53c40f0: Keep claim ownership IDs consistent with their published snapshot during concurrent edits.
- 09e1aa9: Reduce presence peer-selection allocations and skip unchanged heartbeat selections.
- e9823dc: Include presence selection and claim publication stages in server performance diagnostics.
- 70330d5: Keep deleted claims hidden and prevent their recreation during backend rollback.
- bbbf3d7: Prevent stale browsers from recreating deleted claims while preserving server reconnection.

## 0.8.0

### Minor Changes

- 75e824d: Expose per-pod capacity on `/metrics`: connected users counted once across channels and tabs, occupied live-sync and presence slots, per-coordinator saturation, admission and rejection counters, pending live work, and event-loop lag. The Helm chart can opt into a `PodMonitor` that scrapes every pod directly.

### Patch Changes

- 612e4d5: Broadcast alarm and status changes to live subscribers with one database read and one encoding per scope, and stop cloning each socket's attachment on every read in the Node live host.
- 0d3ddb6: Add an admin endpoint that reports where live tile uploads, offers, and paint reports spend their time per stage, and record it in the 256-user benchmark results.
- 612e4d5: Include the Postgres adapter's connection turn wait and statement execution time in the ingest-timings snapshot.
- 0d3ddb6: Write derived mismatch masks after the live reply through a bounded background writer that drains on shutdown, so slow object storage no longer delays tile acknowledgements.
- d2a9fce: Run PostgreSQL and CNPG application queries on the connection pool instead of one owned session, fenced by advisory locks so there is still exactly one writer at a time: a replacement owner cannot serve until every session of the previous owner has closed, and a lost owner session ends its pool at once.
- 0d3ddb6: Reply to tile uploads and paint reports faster at high user counts by sharing one classification per canvas and template chunk across reporters, classifying with typed-array kernels, and storing each canvas hash's bytes once even when many reporters upload it at the same time.
- 612e4d5: Answer multi-tile offer batches sooner by processing their tiles concurrently, and fold a tile's history on its first observation and then at most every 30 seconds instead of on every reply.
- 54d0444: Let pooled PostgreSQL transactions on the tile tables take turns in one lane and the coordinator's callbacks in another while other transactions overlap, retry a serialization failure before answering a command as unavailable, verify the owner session from every fenced session, and report lane wait and retries in the ingest-timings snapshot.
- 4567110: Let a Node or Bun deployment raise the live subscriber limit with `CAELESTIS_LIVE_SUBSCRIBER_LIMIT` for capacity measurements; the default stays 256.

## 0.7.1

### Patch Changes

- e61ddfe: Remove the 500-claim cap per season and surface: every region claim is stored, listed, sent to clients, and kept by the userscript.

## 0.7.0

### Minor Changes

- 7381490: Run the portable backend on Bun or Node with matching versioned container images.

### Patch Changes

- 84f0ece: Publish semantic container tags with Bun as the default backend image.
- ecaffd2: Publish portable container images to Docker Hub and GHCR.

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
