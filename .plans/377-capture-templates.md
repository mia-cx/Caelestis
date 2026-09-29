# #377 Capture map regions as movable templates

## Summary
Select part of the world map with the claim editor's tools, capture the committed Wplace art inside
it, then download it as a PNG or add it as a new template and place it with the normal placement
flow. Mia's comment on the issue: reuse the claim flow's vector tools for the selection.

## Design
- Capture mode is the claim editor with a different purpose. Same drawer, tools, keys and overlay.
  It starts empty (no saved claims load), needs no presence server, and its bar offers
  Download PNG and Add as template instead of Save claims. Enter adds as template.
- The selection is the whole document rasterised as one mask, so any shape works, not just
  rectangles. Pixels outside the mask are transparent; the image is the selection's bounding box.
- Capture reads `captureCurrentArtwork`'s committed world-tile path: every touched tile loads
  first, and a tile that cannot load fails the capture instead of reading as transparent. Drafts,
  overlays and markers never enter it.
- Add as template feeds the PNG through the same import path as Import template, into the tree
  row it was started from, placed over the source so the user drags it onto the damaged area.
- Entry point: "Capture from canvas" beside every "Import template" entry, world surface only
  (claim mode has no alliance artboard support).

## Acceptance criteria
- [ ] Select a region on the world map, snapped to Wplace pixels.
- [ ] Capture reads only committed art; drafts, overlays, markers, map and UI are excluded.
- [ ] Exact colours, dimensions and transparency at one image pixel per Wplace pixel, at any zoom.
- [ ] Selections across tile boundaries load their tiles first; missing data fails the capture.
- [ ] The capture is an independent snapshot.
- [ ] Download PNG, or add as template through normal creation and placement; nothing is painted.

## TODOs
- [ ] UI: capture purpose in the claim mode bar, capture intents, capture icon for tree actions.
- [ ] Capture committed art inside a selection mask, with a focused test.
- [ ] Claim editor: capture mode that starts empty and hands the selection to a capture host.
- [ ] Tree entries and the capture flow: download or import into the chosen row, then place.
- [ ] Changeset for the userscript.
- [ ] Final validation, including a live check in the debug Chromium.

## Notes
