# #426 fix(userscript): save independent regions as separate claims

## Summary
Claim mode flattens every owned claim into one editor set and used to save it back as one
record. PR #427 splits the set into independent groups at save time, previews each group at
its own bounds, and batch-saves with retryable ids. Review found gaps that this plan closes.

## Acceptance criteria
- [x] Distant small regions preview with the correct pixel count and save as separate claims.
- [x] Saving existing separate claims does not merge them merely because they were edited together.
- [ ] Overlaps, subtractors, and later additions retain their pixel coverage and editable shapes across save and reopen.
- [ ] Size and complexity checks apply to individual claims; server resource bounds kept.
- [ ] A failed or partial save retries without duplicating claims or dropping unsaved regions.
- [x] Focused tests and a userscript changeset.

## TODOs
- [ ] Group by source claim: items remember which loaded claim they came from; connected
      components are found within a source claim, new items join the first group whose bounds
      they intersect, and items from different claims never merge. (pullfrog claim-editor:384,
      macroscope O(n²))
- [ ] Reject more than MAX_PRESENCE_REGIONS output documents before saving. (macroscope :61)
- [ ] Reuse a source id only for a 1:1 mapping; a split source keeps its record with
      replaceAfter and every output gets a fresh id. (pullfrog claim-routing:294)
- [ ] Tests: overlapping claims A/B with cross-claim subtract survive save/reopen; split with a
      later PUT failure keeps the remote source intact; aggregate limit.
- [ ] Visual QA in Chromium over CDP: preview, save, reopen, cancel.
- [ ] Reply to and resolve the five review threads; push.

## Notes
- Bounding-box intersection stays as the grouping test (macroscope :43): conservative and
  cheap; bbox-touching shapes forming one claim is valid.
- CNPG helm jobs fail on main too; unrelated.
