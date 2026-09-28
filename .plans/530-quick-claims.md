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
- [ ] Ctrl+drag draws a rectangle only while the paint drawer is open, without painting, panning, or Wplace's own selection.
- [ ] Ctrl+click on macOS does not open the context menu over the map while the drawer is open; elsewhere it is untouched.
- [ ] Each drag adds one quick claim, shown at once, and other painters see it.
- [ ] Closing the paint drawer (submit or cancel) clears every quick claim from that tab.
- [ ] Closing or crashing the tab clears them once the presence session ends. No manual cleanup.
- [ ] Quick claims never outlive their session, even if a clear message fails.
- [ ] Editor claims are unaffected.
- [ ] Focused coverage and Changesets for userscript and backend.

## TODOs
- [x] Shared contract: types, limit, wire schema, contract tests.
- [ ] Backend (Codex): coordinator stores, validates, relays and forgets quick claims; tests.
- [ ] Userscript: presence client publishes quick claims and reads peers' quick claims.
- [x] Userscript: Ctrl+drag input, Ctrl+click removal, context-menu suppression, clear on drawer close.
- [ ] Userscript: draw own and peers' quick claims, with a hover label for peers.
- [ ] Changesets for userscript and backend.
- [ ] Final validation.

## Notes
