# #370 List live players with flyTo actions in the Painters drawer

## Summary

The Painters drawer lists region claims. Replace that with a compact list of who is online, built from live presence, each row with a Fly to button that takes the map to that player's viewport.

## Acceptance criteria

- [x] Show players from live presence, including people without a region claim.
- [x] Each available flyTo action takes the map to that player's latest known activity.
- [x] Keep the list current as players join, move, and leave. Handle unavailable locations without navigating to stale coordinates.
- [x] Support keyboard navigation and clear player identification.

## TODOs

- [x] Add `PainterRowModel` and a `players` list to `PresenceSummaryModel`; add a `presence-fly` panel intent.
- [x] Build the player list in `presence-actions.ts` from live peers; add `flyToPainter`.
- [x] Render the list in `WorkSummary.svelte` with a colour swatch, name, id, activity, and a Fly to button; keep "Claim a region".
- [x] Wire the intent in `Panel.svelte` and `panel.ts`; drop the claim list's Edit path.
- [x] Unit tests for the model and for flyTo; add a Changeset.

## Notes

- The drawer already rerenders on every presence change (`onPresenceChange(rerenderTree)` in `panel.ts`), so join, move, and leave are covered without new plumbing.
- Fly to goes to drafted pixels, else the viewport. Claims are never a destination: Mia opened the issue to get rid of the claim list, and a claim is not where someone is.
- Only live peers are listed. Painters known only by a claim, and your own session, are left out.
- `flyToPainter` re-reads presence at click time, so a player who left between render and click gets a toast instead of a stale flight.
- The drawer's Edit button went with the claim list, and `openClaimEditor` with it. M and the select tool edit your regions on the live server.
- Peers include only sessions the server sends for this viewport's interest area (viewport plus padding, nearest 64), so the list is who is nearby, not the whole headcount in the header. The copy says so. A full roster needs a backend change and is a follow-up.
- The drawer is hidden without the socket: there is nobody to list and the claim button is disabled anyway. Cached claims stay drawn on the map.
