# #395 A feature to show you when your charge is full

## Summary

Show how long until the Wplace pixel charges are full, so painters can plan and avoid overflowing at the cap.

## Acceptance criteria

- [x] A small readout near Wplace's Paint button shows the time until charges are full, counting down live.
- [x] The readout says charges are full once the cap is reached, and hides when Wplace has not reported charges.
- [x] Accepted paints lower the estimate at once, without waiting for Wplace to re-read `/me`.
- [x] The userscript release notes include the feature.

## TODOs

- [x] Add a charge model fed from `/me` (own read and Wplace's page reads) and accepted paints, with a forecast and tests.
- [x] Render the countdown chip anchored above the Paint button, updated each second and repositioned with the rail.
- [x] Add the Changeset, run userscript tests, typecheck, lint, and build.

## Notes

- Model: `wplace-charges.ts` keeps one `/me` reading and projects `count` forward; accepted paints spend against the projection. Fed by the userscript's own `/me` read and by the page fetch tap in `tile-transform.ts`.
- Chip: `ui/charge-forecast.ts`, a fixed pill above `paintDockButton()`, repositioned from the panel's rail sync and resize handler, text refreshed each second.
- Validation: userscript 1,525 tests, typecheck, build, Biome lint, and `pnpm test:release` (52) all pass.

- Wplace `/me` returns `charges: { count, max, cooldownMs }`; `count` is fractional and regenerates one charge per `cooldownMs`.
- The userscript's own `fetch` is sandboxed, so Wplace's page reads of `/me` need the page-realm fetch tap as well.
