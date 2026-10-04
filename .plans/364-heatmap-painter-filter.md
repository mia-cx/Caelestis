# #364 Per-user filter on the contribution heatmap

## Summary
Let someone narrow the contribution heatmap to one painter, and return to everyone.

## Acceptance criteria
- [x] Defaults to all users, unchanged from before.
- [x] Pick a painter by display name or Wplace id; pick "All users" to return.
- [x] Daily totals, cell intensity, and tooltip counts all follow the filter; scope and calendar range stay.
- [x] Selection is a Wplace id, so renames and live refreshes keep it.
- [x] A filtered view excludes imported archive estimates; all users keeps imported-versus-reported precedence.

## TODOs
- [x] `contributionPainters` builds choices from the heatmap's own rows, keyed by id.
- [x] `PainterFilter.svelte`: single-select popover on the pace picker's conventions, rows show `#id`.
- [x] StatsPanel filters rows and drops imported estimates for one painter; resets on scope change.
- [x] Contract test for namesakes, renames, and ordering.
- [x] Changeset, DESIGN.md note, screenshots.

## Notes
- `ContributionHeatmap.svelte` is unchanged: it already derives totals, levels, and labels from the rows it gets.
- Archive-only days could not be seeded locally (the backfill needs the external archive), so that case is
  covered by passing an empty imported map for a filtered view.
