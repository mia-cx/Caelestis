# #464 Prevent deleted claims from reappearing

## Summary

Two browsers can repeatedly delete and recreate the same claim because deletion
erases the server's ownership record and stale saved intent treats absence as a
missing replica. Keep terminal deletion records, distinguish replica withdrawal,
and retire stale client intent when a server reports deletion.

## Acceptance criteria

- [x] Explicitly deleted or replaced claim IDs cannot be recreated, including retries and concurrent writes.
- [x] Ownership checks prevent unauthorized deletion or claim ID reservation.
- [x] Replica withdrawal permits authenticated reconnection and recipient changes.
- [x] Updated clients propagate authoritative deletion and stop recreating claims.
- [x] Storage adapters and a two-client reconciliation regression verify the behavior.

## TODOs

- [x] Persist terminal claim deletion and reversible withdrawal across storage adapters and API, with route regressions and migrations.
- [x] Teach userscript transport and routing to distinguish withdrawal from deletion and retire authoritative deleted intent, with focused regressions.
- [x] Validate the two-client conflict and release checks and document production guard retirement.

## Notes

- User requested issue filing and implementation after production incident containment.
- Issue #464 is In Progress in the repository's Roadmap project.
- Current harness branch already has open PR #463 for touching-claim display; preserve branch and existing work and extend that PR's scope.
- Production guard `incident_20260919_retired_claims` remains active. This implementation is not permission for another production rollout.
- Use an active/withdrawn/deleted state on the existing identity record. Keeping the primary key makes concurrent stale inserts harmless; update predicates cannot reactivate deleted rows. Withdrawn identities retain ownership so reconnection and a racing explicit deletion remain authorized.
- Keep terminal IDs indefinitely because legacy clients do not send an original expiry or generation with PUT. Clear their stored geometry to keep deletion records small.
- Backend route regressions first failed across memory, D1, and SQLite (stale PUT returned 200). All 94 route tests now pass, including a paused in-flight update after deletion. Backend TypeScript checks pass.
- All 152 route cases also pass with disposable local PostgreSQL 17 and MariaDB 11.8. Userscript checks and 50 routing/transport tests pass after adding terminal deletion handling.
- Final review found that replica TTL expiry must remain recoverable when another server keeps the logical claim renewed. Test and preserve that distinction before completion.
- Expiry removes a replica; only explicit deletion retains a terminal identity. Legacy DELETE without `withdraw` remains reversible, because old clients use it for recipient cleanup. Updated clients send `withdraw: false` for deletion and `true` for replica cleanup.
- Terminal deletion reaches previously withdrawn replicas, with separate deletion/withdrawal receipts. Disconnect cleanup preserves pending explicit deletion.
- Two independent routers against two real memory stores converge when one replica was offline at deletion. Reloading saved intent performs no additional PUTs.
- `scripts/retire-20260919-claims.sql` transitions the live incident guard after deployment. A replacement trigger blocks stale active inserts while terminal identities are seeded. Route tests probe between each step, repeat the script, and recreate the D1 adapter. The script has not run in production.
- Final validation: 883 backend tests pass (12 optional tests skipped), 1,597 userscript tests pass, and 163 route cases pass across memory, D1, SQLite, PostgreSQL 17, and MariaDB 11.8. Both app checks/builds pass. Lint passes with two existing constructor infos; 52 release checks pass.
