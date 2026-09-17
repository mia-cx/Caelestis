# #380 Userscript buttons overlap with wplace buttons on small screens

## Summary

Our rail is a fixed column stacked under wplace's. On short viewports it runs into wplace's bottom-right controls (My location, profile) or off screen. Cap the rail above the nearest wplace button below it. Buttons that do not fit go behind a More rail button that pops out a row of them.

## Acceptance criteria

- [x] On a viewport too short for both rails, our buttons stop above wplace's bottom-right buttons.
- [x] Every rail button stays reachable: the ones that do not fit open from a More button, and the popout closes after use, on Escape, or on an outside tap.
- [x] Tall viewports are unchanged: one column under wplace's rail.
- [x] The userscript release notes include the fix.

## TODOs

- [x] Find the highest wplace button under the rail column, with a happy-dom test.
- [x] Cap the rail height above it and move overflow behind More; add the changeset.
- [x] Run userscript tests, typecheck, lint, build, and verify in Chromium at a small viewport.

## Notes

- Validation: `pnpm test` in the userscript passed 1,519 tests; turbo typecheck, `pnpm lint`, build, and `pnpm test:release` (52 tests) pass.
- Chromium at 390x400, logged out: Caelestis, colour, and More end at 312px, above My location at 340px; mismatch, painters, and claim open in a row left of More and close after a tap, on Escape, and on an outside tap. At 1280x900 the rail is one column, unchanged.

- Logged-out wplace at 390x500 has My location in `right-safe-3 bottom-safe-min-3 absolute z-30`, top 440.
- Mia rejected a second column: the space left of the rail belongs to per-overlay controls. Overflow lives behind More instead.
- Rail state syncs find buttons by id, so the rail must be laid out before the install-time syncs run.
