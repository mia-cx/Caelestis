# #378 Update select areas of templates

## Summary
Some canvas art is better than its template: a custom character, a nicer sprite. The overlay shows
it as wrong. Let the user select those parts of an existing template and take the committed canvas
art there as correct, leaving the rest of the template alone. Mia's comment: reuse #377's capture
flow, so you replace parts of a template instead of the whole.

## Design
- "Use canvas artwork in an area" sits beside "Use canvas artwork" in a template's menu, world
  templates only. It opens the #377 capture editor with an update purpose: Cancel and
  Update template in the bar, Enter updates.
- Only template pixels inside the selection change. They follow the whole-template rule: painted
  committed art replaces the target, unpainted canvas keeps it. Only tiles under selected template
  pixels load; a missing one fails the update.
- A confirmation names the number of pixels that will change before anything saves. Saving goes
  through the same Local and server version path as "Use canvas artwork".
- Keys inside an open dialog pass through the editor, so the confirmation works from the keyboard.

## Acceptance criteria
- [ ] Select part of an existing template and see how many pixels the update changes.
- [ ] Only committed art inside the selection is read; drafts and overlays never enter it.
- [ ] Pixels outside the selection, placement, name, and settings stay unchanged.
- [ ] Cancelling leaves the template unchanged; unloaded canvas fails visibly.
- [ ] Saves through the normal Local and server template version flow.

## TODOs
- [x] Capture committed art into a template inside a selection, with a focused test.
- [x] Capture editor: update purpose, its bar actions, and dialog keys passing through.
- [ ] Update flow and the template menu entry.
- [ ] Changeset for the userscript.
- [ ] Final validation and before/after screenshots.

## Notes
