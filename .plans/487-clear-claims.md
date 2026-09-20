# #487 Clear claims without the original token

## Acceptance criteria
- The drawer lists server-confirmed claims only.
- Explicit clearing works with a current write-capable token.
- Withdrawal and editing retain their credential checks.
- Terminal deletion prevents stale replay; failures retain cleanup intent.

## TODOs
- [x] Fix cached-only rows and cover the reported symptom.
- [x] Add explicit clearing through the drawer, router, and backend with permission tests.
- [x] Validate affected packages and rendered controls.

## Notes
- Mia confirmed clearing is restricted to the same Wplace user, regardless of creating token.
- The stale-list test failed on the original code and passes with snapshot-only rows.
- Keep local retry intent separate from the visible server-confirmed list.
- Workspace build/check and lint pass; lint reports two existing informational constructor warnings.
- Tests pass: userscript 1608, backend 887 (15 skipped), UI 152, frontend 175, shared 255, wire-schema 203, storage 11, release 52.
- The default userscript run timed out in an unrelated state test; the full suite passed with four workers.
- Root test scripts pass except live-paint-runtime.test.mjs: its existing semicolon splitter breaks the trigger in migration 0028 with D1_ERROR: incomplete input. Neither file changes in this work.
- Chromium CDP fixture checks passed for keyboard clearing, stable pending button bounds, phone width, light/dark themes, and empty state. Fixture responses are simulated; backend permissions and retry behavior have separate executable tests.
