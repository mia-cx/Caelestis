# #426 fix(userscript): save independent regions as separate claims

## Summary
Claim mode flattens every owned claim into one editor set and used to save it back as one
record. PR #427 splits the set into independent groups at save time, previews each group at
its own bounds, and batch-saves with retryable ids. Review found gaps; Mia confirmed the design
on 2026-09-18: flat grouping by shared pixels (add or subtract), what you see is what you save,
fresh ids for split pieces, and no claim cap at all.

## Acceptance criteria
- [x] Distant small regions preview with the correct pixel count and save as separate claims.
- [x] Saving existing separate claims does not merge them merely because they were edited together.
- [x] Overlaps, subtractors, and later additions retain their pixel coverage and editable shapes across save and reopen.
- [x] Size and complexity checks apply to individual claims; server resource bounds kept per claim.
- [x] A failed or partial save retries without duplicating claims or dropping unsaved regions.
- [x] Focused tests and a userscript changeset.

## TODOs
- [x] Group by shared pixels: bounding boxes only prefilter; shapes whose pixels touch, adding
      or cutting, form one claim, and a subtractor across two regions joins them.
- [x] Fresh ids on split: reuse a source id only for a one-to-one mapping; a split source keeps
      its record with replaceAfter until every piece is accepted.
- [x] Remove MAX_PRESENCE_REGIONS from shared, wire schema, region stores, the userscript
      snapshot handling, and the backend test. Backend changeset.
- [ ] Visual QA in Chromium over CDP: preview, save, reopen, cancel.
- [ ] Reply to and resolve the five review threads; push; update the PR body.

## Notes
- Macroscope's cap comment misread its scope: the cap was per server, not per user. Removed
  outright at Mia's request.
- Pullfrog's provenance comment is declined by design: the editor canvas is the truth and
  merged regions composite in item order.
- CNPG helm jobs fail on main too; unrelated.
- Follow-up filed: #428 find and fly to region claims.
- Validation: userscript 1,542 tests, build, and check pass; backend regions tests pass; shared
  and wire-schema tests pass; biome clean on touched files.
