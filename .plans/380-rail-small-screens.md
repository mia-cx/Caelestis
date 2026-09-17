# #380 Userscript buttons overlap with wplace buttons on small screens

## Summary

Our rail is a fixed column stacked under wplace's. On short viewports it runs into wplace's bottom-right controls (My location, profile) or off screen. Cap the rail above the nearest wplace button below it and wrap extra buttons into a second column to the left.

## Acceptance criteria

- [x] On a viewport too short for both rails, our buttons stop above wplace's bottom-right buttons.
- [x] Every rail button stays on screen and clickable; extra buttons wrap into a column to the left.
- [x] Tall viewports are unchanged: one column under wplace's rail.
- [x] The userscript release notes include the fix.

## TODOs

- [x] Find the highest wplace button under the rail column, with a happy-dom test.
- [x] Cap the rail height above it and wrap buttons leftward; add the changeset.
- [x] Run userscript tests, typecheck, lint, build, and verify in Chromium at a small viewport.

## Notes

- Validation: `pnpm test` in the userscript passed 1,519 tests; turbo typecheck, `pnpm lint`, build, and `pnpm test:release` (52 tests) pass.
- Chromium at 390x400, logged out: three buttons in the right column ending at 312px, above My location at 340px; two wrap left. At 1280x900 the rail is one column, unchanged.

- Logged-out wplace at 390x500 has My location in `right-safe-3 bottom-safe-min-3 absolute z-30`, top 440.
- Chromium wraps a column flex container with `flex-wrap: wrap-reverse` at `max-height`; wrapped columns grow left of a `right`-anchored container.
