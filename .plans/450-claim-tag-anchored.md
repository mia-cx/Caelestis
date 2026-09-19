# #450 fix(userscript): claim tag climbs above another painter's claim

## Summary
The hover tag of a claim treats every other painter's claim as an obstacle and climbs above it. That detaches the tag from the claim it names. Tags are DOM chips over the GL layer, so they may sit on other claims. Drop the obstacle handling; keep viewport clamping and tag-to-tag stacking.

## Acceptance criteria
- [x] Ownership labels stay anchored to their own claims when another person's claim occupies the label's normal position.
- [x] Labels remain readable above other claim overlays.
- [x] The stacked green/purple case places the green label near its own claim's top edge.
- [x] Focused placement tests allow label-over-claim overlap while preserving viewport bounds.

## TODOs
- [x] (with the test TODO, one commit so the suite stays green) Remove the other-claim obstacle loop and `otherClaimPieces` from `presence-labels.ts`; keep the top-edge clamp and tag stacking.
- [x] Replace the two climb-off tests with anchored-over-claim and top-edge-clamp tests.
- [x] Changeset, check, test, lint.

## Notes
- The chip host is a fixed DOM layer at z-index 20 over the GL canvas, so a tag already renders above every claim overlay. Only the placement loop treated other claims as obstacles; it is gone, with `otherClaimPieces`.
- Validation: `pnpm turbo check --filter=@caelestis/userscript` passes. `vitest run presence-labels` 13 pass. Biome clean on both files. Full userscript suite: 1557 pass, 10 fail in `wplace-theme.test.ts` and `ui/display-mode.test.ts`, all on `localStorage` being undefined under happy-dom on Node 26; neither imports the label code, so they are pre-existing.
- Not verified in a browser: the fix removes a placement rule, and the happy-dom tests pin the chip position.
