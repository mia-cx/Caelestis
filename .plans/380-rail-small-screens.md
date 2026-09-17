# #380 Userscript buttons overlap with wplace buttons on small screens

## Summary

Our rail is a fixed column stacked under wplace's. On short viewports it runs into wplace's bottom-right controls (My location, profile) or off screen. Cap the rail above the nearest wplace button below it and wrap extra buttons into a second column to the left.

## Acceptance criteria

- [ ] On a viewport too short for both rails, our buttons stop above wplace's bottom-right buttons.
- [ ] Every rail button stays on screen and clickable; extra buttons wrap into a column to the left.
- [ ] Tall viewports are unchanged: one column under wplace's rail.
- [ ] The userscript release notes include the fix.

## TODOs

- [x] Find the highest wplace button under the rail column, with a happy-dom test.
- [ ] Cap the rail height above it and wrap buttons leftward; add the changeset.
- [ ] Run userscript tests, typecheck, lint, build, and verify in Chromium at a small viewport.

## Notes

- Logged-out wplace at 390x500 has My location in `right-safe-3 bottom-safe-min-3 absolute z-30`, top 440.
- Chromium wraps a column flex container with `flex-wrap: wrap-reverse` at `max-height`; wrapped columns grow left of a `right`-anchored container.
