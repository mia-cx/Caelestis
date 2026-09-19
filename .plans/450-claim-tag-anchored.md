# #450 fix(userscript): claim tag climbs above another painter's claim

## Summary
The hover tag of a claim treats every other painter's claim as an obstacle and climbs above it. That detaches the tag from the claim it names. Tags are DOM chips over the GL layer, so they may sit on other claims. Drop the obstacle handling; keep viewport clamping and tag-to-tag stacking.

## Acceptance criteria
- [ ] Ownership labels stay anchored to their own claims when another person's claim occupies the label's normal position.
- [ ] Labels remain readable above other claim overlays.
- [ ] The stacked green/purple case places the green label near its own claim's top edge.
- [ ] Focused placement tests allow label-over-claim overlap while preserving viewport bounds.

## TODOs
- [ ] Remove the other-claim obstacle loop and `otherClaimPieces` from `presence-labels.ts`; keep the top-edge clamp and tag stacking.
- [ ] Replace the two climb-off tests with anchored-over-claim and top-edge-clamp tests.
- [ ] Changeset, check, test, lint.

## Notes
