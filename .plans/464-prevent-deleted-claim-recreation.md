# #464 Prevent deleted claims from reappearing

## Summary

Two browsers can repeatedly delete and recreate the same claim because deletion
erases the server's ownership record and stale saved intent treats absence as a
missing replica. Keep terminal deletion records, distinguish replica withdrawal,
and retire stale client intent when a server reports deletion.

## Acceptance criteria

- [ ] Explicitly deleted or replaced claim IDs cannot be recreated, including retries and concurrent writes.
- [ ] Ownership checks prevent unauthorized deletion or claim ID reservation.
- [ ] Replica withdrawal permits authenticated reconnection and recipient changes.
- [ ] Updated clients propagate authoritative deletion and stop recreating claims.
- [ ] Storage adapters and a two-client reconciliation regression verify the behavior.

## TODOs

- [x] Persist terminal claim deletion and reversible withdrawal across storage adapters and API, with route regressions and migrations.
- [~] Teach userscript transport and routing to distinguish withdrawal from deletion and retire authoritative deleted intent, with focused regressions.
- [ ] Validate the two-client conflict and release checks, document production guard retirement, and update the existing PR.

## Notes

- User requested issue filing and implementation after production incident containment.
- Issue #464 is In Progress in the repository's Roadmap project.
- Current harness branch already has open PR #463 for touching-claim display; preserve branch and existing work and extend that PR's scope.
- Production guard `incident_20260919_retired_claims` remains active. This implementation is not permission for another production rollout.
- Use an active/withdrawn/deleted state on the existing identity record. Keeping the primary key makes concurrent stale inserts harmless; update predicates cannot reactivate deleted rows. Withdrawn identities retain ownership so reconnection and a racing explicit deletion remain authorized.
- Keep terminal IDs indefinitely because legacy clients do not send an original expiry or generation with PUT. Clear their stored geometry to keep deletion records small.
- Backend route regressions first failed across memory, D1, and SQLite (stale PUT returned 200). All 94 route tests now pass, including a paused in-flight update after deletion. Backend TypeScript checks pass.
