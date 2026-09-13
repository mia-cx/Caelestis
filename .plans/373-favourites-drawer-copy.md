# #373 Replace stale claims copy in the Favourites drawer

## Summary

The Favourites drawer still says "claims" in its toggle and its empty state. Rename the visible copy and accessible labels to favourites, and point the empty state at the control that actually adds one.

## Acceptance criteria

- [x] The Favourites drawer consistently calls these items favourites.
- [x] Its instructions match the controls people use to add or remove favourites.
- [x] Actual region-claim features retain their claim terminology.

## TODOs

- [x] Rename the toggle and empty state in `WorkSummary.svelte`; add a userscript Changeset.

## Notes

- There is no right-click "Claim" item. The real control is the claim marker on a template row's icon, whose popover offers "Claim" and "Release claim". The empty state now names that.
- The marker itself keeps "Claim" wording: it is shared with admin assignment and the tree's Claims filter, and the issue scopes the rename to the drawer.
- Follow-up, not in scope: the marker only renders when a template already has claimants or the viewer can assign, so a plain painter cannot favourite a fresh template from the tree.
