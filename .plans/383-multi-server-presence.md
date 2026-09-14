# #383 Route region claims and viewport presence across connected servers

## Summary

Stack on PR #351. Publish presence to every compatible server and reconcile one logical claim across eligible servers.

## Acceptance criteria

- [x] Viewports and drafts reach every connected presence server with existing throttles and nearby filtering.
- [x] Replicated sessions and claims appear once.
- [x] Claims route by overlapping templates within their season and drawing surface; no overlap falls back to all compatible servers.
- [x] Adding servers and changing templates re-evaluates existing claims, including fallback transitions.
- [x] Editing/deleting reconciles copies; disconnect attempts bounded cleanup before credentials are removed.

## TODOs

- [x] Deliver and deduplicate presence across servers, with protocol and client tests.
- [x] Expire claims after 30 days and renew authenticated owners without reviving expired claims, with store and connection tests.
- [x] Persist claim intent and reconcile routing, edits, deletes, replay, and disconnect cleanup, with focused tests.
- [x] Wire the claim editor to logical claims, add release notes, and run final validation.
- [x] Share claim intent safely between browser tabs and bound retry work for failed servers.
- [x] Address independent review findings and verify the final stacked diff.

## Notes

- Base `origin/t3code/cloud-independent-adapters`, initially `146861d4`; working branch `t3code/portable-runtime-followup`.
- Initial tree clean; rebased onto the requested base before implementation.
- Mia adopted the TTL: authenticated presence connections and heartbeats renew matching credential/painter claims; expired local intent is discarded before replay.
- Existing servers generate unrelated session IDs. Add an optional per-tab publisher ID, independent of credential/client admission IDs, to identify replicated sessions.
- Nearby filtering cannot establish a deduplicated global online total. Count the unique received nearby sessions in the drawer.
- TTL validation: 94 region/presence tests pass; backend typecheck passes. SQL migrations cover SQLite/D1, PostgreSQL, and MariaDB. Existing claims receive 30 days from migration.
- Renewal runs at authenticated connection and hourly while valid messages keep the socket alive. Durable room alarms remove expired claims even without sockets.
- Routing uses complete admitted catalogs and rasterized claim pixels, including subtractors and world-wrapping template bounds. Missing catalogs delay routing instead of triggering a false fallback.
- Local intent and known copies persist before requests. Per-connection acknowledgements skip unchanged writes; failures retry. Old recipients remain until replacements succeed. Disconnect aborts and waits for in-flight writes before bounded best-effort deletes.
- Focused validation: 20 client/routing tests, 16 presence coordinator tests, and userscript typecheck pass.
- Integration validation: 1,499 userscript tests and 822 backend tests pass (10 external-service tests skipped in this pass). Real PostgreSQL/MariaDB migration and region suites pass 136 tests.
- Workspace build/check, Biome, and 39 release tests pass. A local Chromium CDP render shows Bob and Carol once with "2 nearby" and no overflow; screenshot `/tmp/caelestis-383-qa/painters.png`.
- Final inspection fixed expiry-alarm rearming for the portable scheduler and added abandoned-row cleanup to periodic maintenance. The focused coordinator/worker/Node suites pass 37 tests afterward.
- Cross-tab writes acquire a browser-wide lock and reload the shared journal before mutation. A stale-tab edit/delete replay test passes. Background reconciliations coalesce; each failed server is attempted once per pass.
- The root parallel suite hit the unchanged raster performance test at 415 ms against 400 ms. All 254 shared tests pass in isolation; all 11 Turbo test tasks pass with package concurrency 1. Fixture/capacity/social/progress/live-paint prerequisites also passed.
- Independent Codex review found five defects, all addressed: Web Locks promise/null handling; targeted renewal acknowledgements instead of room-wide documents; receipt invalidation when authoritative snapshots lose/change copies; writable-recipient filtering; and Drizzle snapshot/journal metadata. Focused rerun passes 30 client tests and 149 backend tests with both external databases. `drizzle-kit generate` confirms no schema changes.
