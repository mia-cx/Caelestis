# #513 Skip correct pixels while holding Shift

## Acceptance criteria
- [x] Shift skips correct pixels while mismatched and unpainted pixels remain paintable.
- [x] Shift draws only where the visible template requires the selected colour.
- [x] Held Space filters every pixel in a fast stroke.
- [x] Releasing Shift restores native painting; picking and undo/redo still work.

## TODOs
- [x] Implement filtering through native input, with focused tests and a userscript Changeset.
- [ ] Validate native draft behavior in background Chromium, run package checks, and file the PR.

## Notes
- Issue #513 is In Progress in Roadmap.
- Wplace interpolates inclusive lines, so filtering pointer endpoints alone is insufficient.
- Use an owned background tab through CDP 9222; never submit paint during verification.
- Mia clarified that Shift must also prevent drawing the wrong selected colour, and therefore skips cells without a visible template colour.
- World map only. Mia explicitly deferred alliance painting.
