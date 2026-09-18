# #386 Add peer sharding and scale k3s pods by connected users

## Summary
#386 is a PRD. This first slice delivers the per-pod capacity telemetry the shard policy
controller and Traefik admission routing need: connected users counted once per pod across
channels and tabs, occupied live-sync and presence slots, per-coordinator saturation, admission
and rejection counters, queued live work, and event-loop lag. Healthy empty pods report zero.
No user IDs or tokens appear as labels. Peer discovery, the peer data plane, fenced ownership
leases, the policy controller, and Traefik integration remain for later slices.

## Acceptance criteria
- [x] `/metrics` exposes `caelestis_connected_users` and `caelestis_live_sync_connections` per pod, zero when empty.
- [x] One user with presence plus live channels and several tabs counts once; live slots count every socket.
- [x] Per-coordinator saturation, presence slots, admission/rejection counters, queued work, and event-loop lag are exposed without user or token labels.
- [x] Helm can opt into a PodMonitor that scrapes every pod directly; docs describe the metric contract and what remains for sharding.

## TODOs
- [x] Add `node/capacity.ts` with the capacity snapshot, admission counters, and event-loop lag sampler, plus unit tests.
- [x] Expose the snapshot from the runtime and render the new metrics in `node/http.ts`, with an integration test over real sockets.
- [x] Add the opt-in PodMonitor to the Helm chart and document the metric contract in `docs/self-hosting.md`.
- [x] Add a changeset and run backend tests, type checks, lint, and `helm template`.

## Notes
- Slice scope only. The PR uses `Refs #386`; the issue stays open for the peer data plane and controller.
- User identity for counting: `token:<tokenHash>` for authenticated sockets, `client:<clientHash>` for anonymous frontend sockets (clientHash already folds the read token hash and clientId).
- Live slot count mirrors admission: every socket in the season host counts, matching `MAX_LIVE_SUBSCRIBERS`.
- Admission counters live in `node/http.ts` because both the Node and Bun transports route upgrades through it. Status 200 on an upgrade route is an admission; 503 is a capacity refusal. Authentication failures are neither.
- Event-loop lag uses `monitorEventLoopDelay`, which Bun also implements; the histogram resets on each scrape.
- The PodMonitor selects `app.kubernetes.io/component: server`, added to the Deployment pod template only, so migration Job pods are not scrape targets. The selector itself is unchanged, which keeps upgrades of existing releases valid.
- Validation so far: 8 unit tests and the new integration test (17 live sockets, 503 on the seventeenth, drain back to zero) pass on Node 24 and Bun; backend `check` passes for Node and Bun; `helm lint` and `helm template` with the monitor on and off render as expected; the schema rejects a bare-number interval.
- Review fix: Pullfrog flagged presence room keys (caller-chosen alliance surfaces, never evicted) as unbounded `coordinator` labels. Presence now aggregates per season and reports the fullest room; sockets only exist for the configured season, so both kinds stay at one series per season.
- Final validation: full backend suite 836 passed, 10 skipped (PostgreSQL and MariaDB cases need external databases); repository lint reports only a pre-existing unused-import warning outside this change.
