# #530 Quick claims that last only as long as a paint session

## Summary
While Wplace's paint drawer is open, Ctrl+drag on the map claims a rectangle. Any number of
rectangles, up to a cap. They vanish when the paint ends (submit or cancel both close the drawer)
and when the tab goes away. Other painters see them like claims.

## Design
- Quick claims are presence-session state, next to the viewport and draft, not stored claims.
  The server forgets them when the socket closes or goes stale (`PRESENCE_STALE_MS`), so they can
  never outlive the session, even if a clear message is lost. No SQL, no TTL, no ownership rows.
- Wire: `presence-update` gains optional `quickClaims: PresenceRect[]` (absent = unchanged,
  `[]` = none). `PresencePeer` gains optional `quickClaims`, omitted when empty. At most
  `MAX_QUICK_CLAIMS` rects, each within `MAX_PRESENCE_REGION_PIXELS` and the world surface.
  Older servers ignore the field; older clients ignore it on peers.
- Only sessions that can write claims (not anonymous, not read scope) may publish them.
- World surface only, like the rest of presence.
- Open questions from the issue, decided: quick claims draw like claims with a dashed outline, and
  Ctrl+click without a drag inside one of your own quick claims removes it (the undo).

## Acceptance criteria
- [x] Ctrl+drag draws a rectangle only while the paint drawer is open, without painting, panning, or Wplace's own selection.
- [x] Ctrl+click on macOS does not open the context menu over the map while the drawer is open; elsewhere it is untouched.
- [x] Each drag adds one quick claim, shown at once, and other painters see it.
- [x] Closing the paint drawer (submit or cancel) clears every quick claim from that tab.
- [x] Closing or crashing the tab clears them once the presence session ends. No manual cleanup.
- [x] Quick claims never outlive their session, even if a clear message fails.
- [x] Editor claims are unaffected.
- [x] Focused coverage and Changesets for userscript and backend.

## TODOs
- [x] Shared contract: types, limit, wire schema, contract tests.
- [x] Backend (Codex): coordinator stores, validates, relays and forgets quick claims; tests.
- [x] Userscript: presence client publishes quick claims and reads peers' quick claims.
- [x] Userscript: Ctrl+drag input, Ctrl+click removal, context-menu suppression, clear on drawer close.
- [x] Userscript: draw own and peers' quick claims, with a hover label for peers.
- [x] Changesets for userscript and backend.
- [x] Final validation.

## Notes
- Backend drafted by Codex gpt-6-astra (brief in `530-codex-backend-task.md`). Its sandbox could not open localhost listeners, so I ran the socket tests: 10/10 quick-claim runtime tests, attachment size test, full backend suite 99 passed / 1 skipped.
- Removed Codex's anonymous guard: the route only makes a session anonymous with read scope, which the coordinator already ignores, so the guard was unreachable (a mutation test showed no test could fail on it).
- Mutation check on the userscript: publishing quick claims only while the tab is visible fails the hidden-tab test, as it should.
- Final validation 2026-09-28: userscript tsc clean, vitest 153/153 (30 files); shared 57; wire-schema 12; frontend check clean; backend tsc, full suite 99 passed / 1 skipped, quick-claim runtime 10/10; Biome clean apart from existing warnings.
- Live check in the debug Chromium on wplace.live with this build injected, zoom 15.5, paint drawer open: Ctrl+drag drew the dashed quick claim; the draft stayed at 0 pixels and the map centre, zoom and bearing did not change; Ctrl+click inside removed it; closing the drawer cleared a new one. Not checked live: another painter seeing it (production backend lacks the change; the runtime socket tests cover it) and the OS-level macOS Ctrl+click menu (CDP cannot synthesise it; the unit test covers the contextmenu event).
- Mia asked for pixel-exact quick claims. Found two gaps: `pickerPointAt` returns fractional canvas positions and quick claims used them as-is (so rects had fractional edges and the server's integer-only schema would have rejected them), and the layer glided maskless rects through sub-pixel positions. Now the pointer snaps to the pixel it is in (floor, nearest-neighbour), `quickClaimRect` floors defensively, and quick claims snap in the layer like mask claims. The input test's fake map now reports fractional positions like the real one; removing the fixes fails 4 tests.
