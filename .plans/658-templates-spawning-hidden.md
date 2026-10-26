# #658 Templates spawning hidden

## Summary
A server import is held as a Local template until Apply uploads it. With Local switched off, its
placement drew nothing: no outline, no Apply or Cancel, and every later placement was refused until
reload.

Decided with Mia (2026-10-26): server imports go into a separate staging group that the sidebar
does not list and no switch can hide.

## Acceptance criteria
- [x] A server import draws, with Apply and Cancel, whatever Local's switches say.
- [x] The sidebar does not list a staged import.
- [x] An import that does not upload is kept in Local, where the sidebar lists it.

## TODOs
- [x] Regression tests: capture into a server with Local off draws; a failed upload is kept in Local.
- [x] `staged` on the template: set on server admission, always drawn, left out of the sidebar,
      cleared after the upload attempt.
- [x] Changeset; userscript test, check, lint.

## Notes
- `Show only this` scopes to one root (Local or one server), so it never hides Local itself; the
  reporter's Local switch was most likely already off.
- `staged` is runtime-only: unplaced imports never persist, and loading drops unknown fields.
- Validation: `turbo run test check --filter=@caelestis/userscript` 46 files/268 tests pass, biome
  clean. The draw test fails on main (`expected false to be true`); the Local test fails without
  the unstage.
