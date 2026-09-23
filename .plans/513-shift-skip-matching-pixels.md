# #513 Skip correct pixels while holding Shift

## Acceptance criteria
- [x] Shift skips correct pixels while mismatched and unpainted pixels remain paintable.
- [x] Shift draws only where the visible template requires the selected colour.
- [x] Held Space filters every pixel in a fast stroke.
- [x] Releasing Shift restores native painting; picking and undo/redo still work.

## TODOs
- [x] Implement filtering through native input, with focused tests and a userscript Changeset.
- [x] Validate native draft behavior in background Chromium and run package checks.

## Notes
- Issue #513 is In Progress in Roadmap.
- Wplace interpolates inclusive lines, so filtering pointer endpoints alone is insufficient.
- Use an owned background tab through CDP 9222; never submit paint during verification.
- Mia clarified that Shift must also prevent drawing the wrong selected colour, and therefore skips cells without a visible template colour.
- World map only. Mia explicitly deferred alliance painting.
- Native event-path check: a 40-cell stroke drafted 34 mismatches and skipped six matches. Retracing kept 34 drafts; undo/redo changed 34 -> 33 -> 34; releasing Shift resumed normal painting.
- Final focused suite: 55 tests passed, including wrong-colour rejection, cells outside visible templates, and alliance pass-through. Typecheck, userscript build, changed-file Biome, and whitespace checks passed.
- Full userscript suite: 1,629 passed; the unrelated file-watcher test timed out under parallel load and passed its isolated rerun.
- Mia is testing this build in her chosen location. Browser control stopped; temporary camera overrides restored and the temporary QA template removed.
