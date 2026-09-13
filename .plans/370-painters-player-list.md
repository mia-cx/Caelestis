# #370 List live players with flyTo actions in the Painters drawer

## Summary

The Painters drawer lists region claims. Replace that with a compact player list built from live presence, each row with a Fly to button that takes the map to that player's latest known activity.

## Acceptance criteria

- [x] Show players from live presence, including people without a region claim.
- [x] Each available flyTo action takes the map to that player's latest known activity.
- [x] Keep the list current as players join, move, and leave. Handle unavailable locations without navigating to stale coordinates.
- [x] Support keyboard navigation and clear player identification.

## TODOs

- [x] Add `PainterRowModel` and a `players` list to `PresenceSummaryModel`; add a `presence-fly` panel intent.
- [x] Build the player list in `presence-actions.ts`: live peers, then claimants who are offline, you first; add `flyToPainter`.
- [x] Render the list in `WorkSummary.svelte` with a colour swatch, name, id, activity, and a Fly to button; keep "Claim a region" and an Edit for your own regions.
- [x] Wire the intent in `Panel.svelte` and `panel.ts`.
- [x] Unit tests for the model and for flyTo; add a Changeset.

## Notes

- The drawer already rerenders on every presence change (`onPresenceChange(rerenderTree)` in `panel.ts`), so join, move, and leave are covered without new plumbing.
- Latest known activity, in order: drafted pixels, viewport, newest region claim. A player with none of those has no Fly to button.
- `flyToPainter` re-reads presence at click time, so a player who left between render and click gets a toast instead of a stale flight.
- Offline claimants are kept in the list so a claim can still be found from the drawer; their Fly to goes to the claim.
- Peers include only sessions the server sends for this viewport's interest area, so the list is what presence knows, not the whole headcount.
