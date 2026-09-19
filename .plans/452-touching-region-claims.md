# #452 Merge touching region claims from the same painter

## Summary
Group shapes whose actual pixels overlap or touch at an edge or corner. Allow existing
owned claims to coalesce on save, preserving ordered composition and separate distant claims.

## Acceptance criteria
- [x] Adjacent pixels connect, including a transitive chain of 13 regions.
- [x] Existing touching claims save together without another edit and reopen as one clean claim.
- [x] Pixel coverage and ordered add/subtract operations survive grouping.
- [x] Disconnected regions and other painters' claims stay separate.
- [ ] Focused tests and a userscript Changeset accompany the fix.

## TODOs
- [x] Group shapes by actual pixel adjacency and test connectivity, gaps, and ordered composition.
- [x] Enable saving existing claims that need regrouping and test save/reopen behavior and ownership isolation.
- [~] Add the userscript Changeset and complete affected checks and diff review.

## Notes
- The workspace starts clean on `t3code/resolve-issue-452`.
- Roadmap status is In Progress.
- Preserve #426's shape grouping, including subtractors that connect groups. Change connectivity only.
- The editor receives owned claims through `myRegions` and `ClaimRouter.mine()`. Ownership behavior needs no change.
- `regionPixelComponents` already uses edge and corner connectivity. The new predicate matches it.
- Grouping validation: shared build and 20 claim-document tests pass; changed files pass Biome.
- Editor/routing validation: all 97 focused tests pass, including saving and reopening 13 touching claims,
  simultaneous splitting and merging, and excluding another painter's adjacent claim from mutations.
- The first editor run lacked the UI package's built output. Building `@caelestis/ui` resolved import failures.
