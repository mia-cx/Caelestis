# #373 Replace stale claims copy in the Favourites drawer

## Summary

The Favourites drawer still says "claims" in its toggle and its empty state. Rename the visible copy and accessible labels to favourites, and make the actions that add one say the same.

## Acceptance criteria

- [x] The Favourites drawer consistently calls these items favourites.
- [x] Its instructions match the controls people use to add or remove favourites.
- [x] Actual region-claim features retain their claim terminology.

## TODOs

- [x] Rename the toggle and empty state in `WorkSummary.svelte`; add a userscript Changeset.
- [x] Rename the context menu item in `tree-actions.ts` and the popover action in `TemplateClaims.svelte` to Favourite / Unfavourite.

## Notes

- The template context menu's personal action is built in `application/tree-actions.ts`, with a dynamic label; the claim popover on a row's icon has the same action. Both now say Favourite / Unfavourite.
- The popover's header, "Claims for X", the claimant count, and the admin "Remove X's claim" stay as claims: they describe every painter's record, not your favourite.
- The frontend's work board keeps "Release claim"; it is the server-side work view, not the userscript.
