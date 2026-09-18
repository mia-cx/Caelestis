# #428 feat(userscript): find and fly to region claims

## Summary
Region claims only exist on the canvas. Add a claim list to the Painters drawer, your own claims first and then everyone else's, with a Fly to button per row that frames the claim on the map.

## Acceptance criteria
- [ ] The Painters drawer lists region claims: mine, then others', each naming the claimant and describing the shapes.
- [ ] Fly to on a claim row frames its bounding rect; a claim that vanished in the meantime toasts instead of flying.
- [ ] Rows share the painter row geometry, long names truncate, and the empty state keeps the same place.

## TODOs
- [ ] Shared UI: claim rows in `PresenceSummaryModel`, a Claims group in the Painters drawer with Fly to, a `claim-fly` panel intent, and a panel render test.
- [ ] Userscript: build claim rows from `claimRouter().mine()` and the presence snapshot's `regions`, add `flyToClaim`, wire the intent in the panel, with tests.
- [ ] Changeset, checks, and browser verification in the existing Chromium.

## Notes
- Data: `mine()` carries local pending claims; `presenceView().regions` carries every server copy. Others' rows come from `regions` minus my user id. World surface only, since Fly to targets the world map.
- Layout: the drawer gets a second group under the painters. Same 1.75rem rows, swatch in the claimant's presence colour, name + description, Fly to on the right. Group labels are small muted captions so the list reads as one column.
