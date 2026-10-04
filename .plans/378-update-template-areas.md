# #378 Update select areas of templates

## Summary
Some canvas art is better than its template: a custom character, a nicer sprite. The overlay shows
it as wrong. Let the user select those parts of an existing template and take the committed canvas
art there as correct, leaving the rest of the template alone. Mia's comment: reuse #377's capture
flow, so you replace parts of a template instead of the whole.

## Design
- "Update an area" sits beside "Use canvas artwork" in a template's menu, world
  templates only. It opens the #377 capture editor with an update purpose: Cancel and
  Update template in the bar, Enter updates.
- Only template pixels inside the selection change. They follow the whole-template rule: painted
  committed art replaces the target, unpainted canvas keeps it. Only tiles under selected template
  pixels load; a missing one fails the update.
- A confirmation names the number of pixels that will change before anything saves. Saving goes
  through the same Local and server version path as "Use canvas artwork".
- Keys inside an open dialog pass through the editor, so the confirmation works from the keyboard.

## Acceptance criteria
- [x] Select part of an existing template and see how many pixels the update changes.
- [x] Only committed art inside the selection is read; drafts and overlays never enter it.
- [x] Pixels outside the selection, placement, name, and settings stay unchanged.
- [x] Cancelling leaves the template unchanged; unloaded canvas fails visibly.
- [x] Saves through the normal Local and server template version flow.

## TODOs
- [x] Capture committed art into a template inside a selection, with a focused test.
- [x] Capture editor: update purpose, its bar actions, and dialog keys passing through.
- [x] Update flow and the template menu entry.
- [x] Changeset for the userscript.
- [x] Final validation and before/after screenshots.

## Notes
- The menu label is "Update an area": longer labels wrapped to two lines in the tree menu.
- The update mode lives only in the tree menu, like #377's capture. The on-map overlay menu keeps
  its single "Use canvas artwork" button.
- Validation 2026-10-01: userscript and ui typecheck, svelte-check, build, and tests pass
  (userscript 173, ui 13). Changed files lint clean.
- Live check 2026-10-01: shared debug Chromium, isolated browser context, live Wplace canvas.
  Imported a 16×16 frame over existing art and selected its top-left corner (90 px, 72 inside the
  template). The confirmation read "Update 72 pixels of “frame”?". Escape closed only the dialog
  and kept the selection. Confirming cleared mismatches in that corner only. Local template only;
  no server writes.
