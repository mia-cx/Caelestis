# #383 Route region claims and viewport presence across connected servers

## Summary

Stack on PR #351. Publish presence to every compatible server and reconcile one logical claim across eligible servers.

## Acceptance criteria

- [ ] Viewports and drafts reach every connected presence server with existing throttles and nearby filtering.
- [ ] Replicated sessions and claims appear once.
- [ ] Claims route by overlapping templates within their season and drawing surface; no overlap falls back to all compatible servers.
- [ ] Adding servers and changing templates re-evaluates existing claims, including fallback transitions.
- [ ] Editing/deleting reconciles copies; disconnect attempts bounded cleanup before credentials are removed.

## TODOs

- [x] Deliver and deduplicate presence across servers, with protocol and client tests.
- [x] Expire claims after 30 days and renew authenticated owners without reviving expired claims, with store and connection tests.
- [ ] Persist claim intent and reconcile routing, edits, deletes, replay, and disconnect cleanup, with focused tests.
- [ ] Wire the claim editor to logical claims, add release notes, and run final validation.

## Notes

- Base `origin/t3code/cloud-independent-adapters`, initially `146861d4`; working branch `t3code/portable-runtime-followup`.
- Initial tree clean; rebased onto the requested base before implementation.
- Mia adopted the TTL: authenticated presence connections and heartbeats renew matching credential/painter claims; expired local intent is discarded before replay.
- Existing servers generate unrelated session IDs. Add an optional per-tab publisher ID, independent of credential/client admission IDs, to identify replicated sessions.
- Nearby filtering cannot establish a deduplicated global online total. Count the unique received nearby sessions in the drawer.
- TTL validation: 94 region/presence tests pass; backend typecheck passes. SQL migrations cover SQLite/D1, PostgreSQL, and MariaDB. Existing claims receive 30 days from migration.
- Renewal runs at authenticated connection and hourly while valid messages keep the socket alive. Durable room alarms remove expired claims even without sockets.
