# #428 feat(userscript): find and fly to region claims

## Summary
Region claims only exist on the canvas. Add a claim list to the Painters drawer, your own claims first and then everyone else's, with a Fly to button per row that frames the claim on the map.

## Acceptance criteria
- [x] The Painters drawer lists region claims: mine, then others', each naming the claimant and describing the shapes.
- [x] Fly to on a claim row frames its bounding rect; a claim that vanished in the meantime toasts instead of flying.
- [x] Rows share the painter row geometry, long names truncate, and the empty state keeps the same place.

## TODOs
- [x] Shared UI: claim rows in `PresenceSummaryModel`, a Claims group in the Painters drawer with Fly to, a `claim-fly` panel intent, and a panel render test.
- [x] Userscript: build claim rows from `claimRouter().mine()` and the presence snapshot's `regions`, add `flyToClaim`, wire the intent in the panel, with tests.
- [x] Changeset, checks, and browser verification in the existing Chromium.

## Notes
- Validation: `pnpm --filter @caelestis/ui check` and `test` (152 pass), `pnpm --filter @caelestis/userscript check` and `test` (1565 pass), biome clean on every changed file. Root `pnpm lint` also reports three pre-existing backend findings in files this branch does not touch.
- Browser: injected the built bundle into a background wplace.live tab over CDP. The drawer listed "Others' claims 3" from the production server, rows at 28px like painter rows, and Fly to on one claim moved the map to its bounding rect. No claims were written; the profile has no claims of its own, so the "Your claims" group is covered by the panel render test only.
- Mia's review: her own claims were missing. "Your claims" read only the local store, and "Others' claims" excludes her user id, so a claim the store had not adopted vanished. Fixed by merging the server snapshot's claims with her user id into the mine group, deduped by id.
- Fly to frames the whole bounding rect. A claim of many scattered shapes lands zoomed out past the pixel view. That is the rect the server derives, so a tighter flight would need per-shape framing later.
- Data: `mine()` carries local pending claims; `presenceView().regions` carries every server copy. Others' rows come from `regions` minus my user id. World surface only, since Fly to targets the world map.
- Layout: the drawer gets a second group under the painters. Same 1.75rem rows, swatch in the claimant's presence colour, name + description, Fly to on the right. Group labels are small muted captions so the list reads as one column.
