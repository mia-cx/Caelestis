# #395 A feature to show you when your charge is full

## Summary

Show how long until the Wplace pixel charges are full, so painters can plan and avoid overflowing at the cap.

## Acceptance criteria

- [ ] A small readout near Wplace's Paint button shows the time until charges are full, counting down live.
- [ ] The readout says charges are full once the cap is reached, and hides when Wplace has not reported charges.
- [ ] Accepted paints lower the estimate at once, without waiting for Wplace to re-read `/me`.
- [ ] The userscript release notes include the feature.

## TODOs

- [ ] Add a charge model fed from `/me` (own read and Wplace's page reads) and accepted paints, with a forecast and tests.
- [ ] Render the countdown chip anchored above the Paint button, updated each second and repositioned with the rail.
- [ ] Add the Changeset, run userscript tests, typecheck, lint, and build.

## Notes

- Wplace `/me` returns `charges: { count, max, cooldownMs }`; `count` is fractional and regenerates one charge per `cooldownMs`.
- The userscript's own `fetch` is sandboxed, so Wplace's page reads of `/me` need the page-realm fetch tap as well.
