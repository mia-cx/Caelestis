# @caelestis/backend

## 1.1.1

### Patch Changes

- da42aa1: A write that lands as an archive or restore begins now gets the same 503 with `retry-after` as every other request during the operation, instead of a 500.
- f1c4e01: A paint report larger than the live transport's 8 MiB limit is refused with a 400 before the server reads all of it, as tile offers and uploads already were.
- da42aa1: Server asset uploads and archive restores without a `Content-Length` are refused once they pass the size limit instead of being read in full, and the restore limit message names 64 MiB.
- 702949e: A tile upload that fails because a template's stored artwork disagrees with its own bounds is answered as a server error, as a tile offer already was, instead of blaming the reporter with a 400.
- 1a802a4: A Worker deployed from the self-hosted example answers requests again: an empty variable, such as its `SERVER_DESCRIPTION = ""`, now counts as unset on both hosts.
- da42aa1: The canvas mirror no longer counts a tile whose refresh fails as both unchanged and failed.
- da42aa1: A live tile upload whose bytes do not match its hash is answered as invalid instead of unavailable.
- 115a52f: Deleting a folder that has subfolders now works on MariaDB.
- 5871409: On MariaDB, counter and server-state transactions that lose a deadlock or time out on a lock now run again, as they already did on PostgreSQL, instead of failing on the first try.
- 328f4fb: Node `/metrics` reports the live-sync limit set by `CAELESTIS_LIVE_SUBSCRIBER_LIMIT`, and counts upgrades on the unversioned `/telemetry/live` and `/telemetry/presence` routes.
- Presence rooms check the state stored on live connections that outlast a deploy, as live sync already did, and refuse a malformed one instead of acting on it.
- 8e85cb1: A self-hosted server's `caelestis_presence_connections` metric counts the same presence sessions room admission counts, so it no longer reads higher than the capacity limit enforces.
- 6d8735a: A self-hosted server started with `PORT=0` renders share images through the port it actually bound, instead of failing to reach port 0 when the job was already due at startup.
- 212c992: Templates on sparse canvas tiles now get progress, status and alarms: the backend decodes the 1-, 2- and 4-bit tiles Wplace serves for them.
- ff91946: A reported tile that does not decode is refused with 400 instead of 500, so reporters stop resending it.

## 1.1.0

### Minor Changes

- f1ac26b: Server folders can backfill history for every template inside them at once, reading each archive tile only once even when several templates share it.

### Patch Changes

- 304a94e: The Node container images run Node 24.22.3, which fixes seven high-severity vulnerabilities in Node 24.22.1.

## 1.0.0

### Major Changes

- d421e5e: Release Caelestis 1.0.0 across the userscript, browser extension, dashboard, and backend.

### Patch Changes

- f1ed2e6: Eralyon backfills download each tile's week once and apply each snapshot's changes once.
- 019f6cd: Hourly claim renewal renews every connected painter in one database write.
- 54b7c8f: Leaderboards rank painters in the database and contribution reads use an index on template and day.
- b1a0a38: Mismatch highlights stay visible while a tile is rechecked after someone paints on it, and the recheck downloads nothing when they are unchanged.
- 8ec7318: Paint reports are acknowledged without waiting for live dashboards to refresh.
- fef8259: Recording a paint no longer scans the counter tables to prune them.
- 030ef1d: Paint reports validate in a single pass, about 40 times faster, and a report may carry at most 1,398,101 pixels, more than the live connection can deliver in one report.
- ce4a4d4: Presence updates in busy rooms only compare each painter with the painters near them.
- e4966e8: Progress history for artwork without cached measurements loads several times faster.
- 18f65e0: Tile scans no longer wake alarm subscribers when no alarm changed.
- b895eeb: Live clients no longer receive alarm and manifest updates when nothing they show changed.
- 9b16720: Template share GIFs render about three times faster: tile, history and map reads now overlap decoding instead of waiting one at a time.
- ee6541b: Tile commits that change progress save only the templates they changed, not the whole season's status.
- 26eff42: `/telemetry/status` sends an `ETag` and answers a matching `If-None-Match` with 304.
- ea61d83: Tile history reuses the current manifest to decide which tiles a reader may see instead of listing every template per request.

## 0.11.0

### Minor Changes

- ea751c0: Keep the crop and processing settings of templates made in the userscript's template editor, so they can be edited again.

## 0.10.0

### Minor Changes

- 5dce098: Server archives no longer carry access tokens, so restoring an old archive can't bring back a revoked token.
- 35a52f1: Cloudflare servers refresh every published template's share GIF daily on their own, with no GitHub Actions workflow.
- 522f8bf: An unpublished template's chunks, source image and recipe now answer 404 to everyone without an admin token.
- 746841b: Callers without an admin token no longer learn anything about an unpublished template.
    - Canvas tiles, tile history and live tile updates cover only published templates.
    - Folders appear only above a published template.
    - Work linked to an unpublished template is hidden, and region claims drop hints that name one.

## 0.9.5

### Patch Changes

- 094a382: Label the Node images with their real Node.js version, 24.22.1, so release validation accepts them.

## 0.9.4

### Patch Changes

- cc8f4a2: Run on Node.js 24.22.1, which fixes the October 2026 Node.js security release vulnerabilities, including the Brotli decoder out-of-bounds write (CVE-2026-111497).

## 0.9.3

### Patch Changes

- af65334: Keep progress charts continuous across artwork updates using retained tile images and show revision changes as steps.

## 0.9.2

### Patch Changes

- 11e10c8: Keep recorded progress visible across template artwork updates without counting artwork changes as painting progress.

## 0.9.1

### Patch Changes

- 42caa5c: Durable jobs now claim a fenced, renewable lease before they run, so several processes sharing one database run each job once. Existing coordinator databases migrate in place on startup.
- 0ec39bd: Claim temporary painting areas by holding Ctrl and dragging on the map.
  
  - Ctrl+click a quick claim to remove it.
  - Closing the paint drawer or the tab clears your quick claims for everyone.
- 9e91a7e: Update server and interface dependencies, including dialog focus and text selection fixes.
- 27cc081: Run RustFS in the Compose S3 example, since MinIO no longer publishes its images. Existing stacks copy their MinIO data over on the next start and keep the old volume untouched until you delete it.
- b797bf0: Export a whole server to one archive file and restore it on any deployment, database, or object store, from Cloudflare to self-hosted and back.
- 806b477: `/server` now reports the backend package version and build identifier.
- ec39a6a: Store the original image and processing recipe with each template version, and serve them from `/v1/recipes` and `/v1/sources`.
- 3f4c9d0: Reject truncated PNG chunks before template import.

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
