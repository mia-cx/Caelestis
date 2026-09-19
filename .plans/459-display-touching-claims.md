# #459 Merge touching claims in the client display

## Summary
The previous fix groups claims on save. Existing records must also look merged before any edit.
Share a cached display union between the GL overlay and hover labels, preserving source documents.

## Acceptance criteria
- [x] Existing adjacent claims from the same painter display as one mask and one hover tag.
- [x] Different painters, seasons, surfaces, and actual pixel gaps stay separate.
- [x] Per-document add/subtract composition and saved records remain unchanged.
- [x] Live claim changes and editor exclusions rebuild the display union.
- [x] Real GL rendering has no internal seams, with screenshots and interaction checks.
- [x] Full userscript checks and a userscript Changeset pass.

## TODOs
- [x] Add cached display unions and focused connectivity, coverage, and invalidation tests.
- [x] Use the same union for overlay masks, labels, and hover fading.
- [x] Verify real Chromium rendering and run affected checks.

## Notes
- Worktree branch remains `t3code/resolve-issue-452`, fast-forwarded to current main after its original PR merged.
- Each union respects the existing four-million-pixel raster budget. Larger unions retain separate masks and full coverage.
- Hovering a constituent with a custom label retains that label while sharing the union boundary.
- 26 focused display, label, and layer tests pass before the final gate.
- Visual fixture uses real GL/rendering/label modules with local records; no production claims are modified.
- Chromium CDP verification passes with a persistent focus-emulation session. Fourteen stored claims produce
  two masks: thirteen connected claims and one distant claim. Sampled seam alpha changes from 242 to 77.
- Hover clears the union fill and keeps the distant claim filled. Remove/restore/edit-bridge controls pass;
  console errors and WebGL errors are zero. Before/after/hover screenshots inspected.
- The sandboxed verification helper could not access loopback. Direct verification in the parent runtime passed.
- Full userscript check/test/build passes: 1,591 tests across 138 files. Lint passes with the existing backend
  unused-import warning and constructor infos; 52 release-tooling tests pass. Final type check passes.
- Rebased onto main's viewport-fill fix; repeated userscript check/test/build, lint, and release validation.
