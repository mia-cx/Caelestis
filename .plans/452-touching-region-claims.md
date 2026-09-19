# #452 Merge touching region claims from the same painter

## Summary
Group shapes whose actual pixels overlap or touch at an edge or corner. Allow existing
owned claims to coalesce on save, preserving ordered composition and separate distant claims.

## Acceptance criteria
- [ ] Adjacent pixels connect, including a transitive chain of 13 regions.
- [ ] Existing touching claims save together without another edit and reopen as one clean claim.
- [ ] Pixel coverage and ordered add/subtract operations survive grouping.
- [ ] Disconnected regions and other painters' claims stay separate.
- [ ] Focused tests and a userscript Changeset accompany the fix.

## TODOs
- [~] Group shapes by actual pixel adjacency and test connectivity, gaps, and ordered composition.
- [ ] Enable saving existing claims that need regrouping and test save/reopen behavior and ownership isolation.
- [ ] Add the userscript Changeset and complete affected checks and diff review.

## Notes
- The workspace starts clean on `t3code/resolve-issue-452`.
- Roadmap status is In Progress.
- Preserve #426's shape grouping, including subtractors that connect groups. Change connectivity only.
- The editor receives owned claims through `myRegions`; inspect that boundary before changing ownership behavior.
