# #487 Clear claims without the original token

## Acceptance criteria
- The drawer lists server-confirmed claims only.
- Explicit clearing works with a current write-capable token.
- Withdrawal and editing retain their credential checks.
- Terminal deletion prevents stale replay; failures retain cleanup intent.

## TODOs
- [x] Fix cached-only rows and cover the reported symptom.
- [ ] Add explicit clearing through the drawer, router, and backend with permission tests.
- [ ] Validate affected packages and rendered controls, rebase, and file a PR.

## Notes
- User decision pending: clearing restricted to the same Wplace user, or any claim with a write-capable token.
- The stale-list test failed on the original code and passes with snapshot-only rows.
- Keep local retry intent separate from the visible server-confirmed list.
