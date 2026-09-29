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
- Add as template passes the captured palette indices through the same admission and placement
  path as Import template, into the chosen tree row. Only Download PNG encodes an image.
- Reserve placement before loading tiles. Closing capture aborts pending work and removes any
  temporary admission; late results cannot close a newer editor session.
- Entry point: "Capture from canvas" beside every "Import template" entry, world surface only
  (claim mode has no alliance artboard support).

## Acceptance criteria
- [x] Select a region on the world map, snapped to Wplace pixels.
- [x] Capture reads only committed art; drafts, overlays, markers, map and UI are excluded.
- [x] Exact colours, dimensions and transparency at one image pixel per Wplace pixel, at any zoom.
- [x] Selections across tile boundaries load their tiles first; missing data fails the capture.
- [x] The capture is an independent snapshot.
- [x] Download PNG, or add as template through normal creation and placement; nothing is painted.

## TODOs
- [x] UI: capture purpose in the claim mode bar, capture intents, capture icon for tree actions.
- [x] Claim editor: capture mode that starts empty and hands the selection to a capture host
  (committed with the UI change, since the model type needs both sides).
- [x] Capture committed art inside a selection mask, with a focused test.
- [x] Tree entries and the capture flow: download or import into the chosen row, then place.
- [x] Changeset for the userscript.
- [~] Final validation. Repo checks pass; the live Wplace check could not run (see Notes).

## Notes
- Capture is world-only. The entries hide on alliance surfaces, and `captureTemplate` refuses
  while an alliance canvas is open.
- Exact colours: template creation retains captured palette indices directly. PNG downloads use
  `encodeIndexedPng`. Out-of-world selections fail rather than wrapping to unrelated artwork.
- Review fixes use the existing cooperative UI model: rail actions can close capture during tile
  loading or temporary admission. The editor owns cancellation, and both Local and server staging
  roll back cancelled captures before starting placement.
- Follow-up validation: lint, typecheck, build, and the full test command pass. Focused tests cover
  exact Local-folder placement, occupied placement, admission failure, server permissions,
  cancellation during tile loading and Local/server admission, later editor sessions, and world edges.
- Validation 2026-09-29: `pnpm lint` clean apart from existing warnings; `pnpm check` clean;
  `pnpm build` clean; `pnpm test` all green (userscript 160/160 in 32 files, backend 99 + 1
  skipped, frontend 68, ui and shared green). New: `test/capture-selection.test.ts` (tile
  crossing, mask, unpainted pixels; unloaded tile fails) and a ClaimMode capture-actions test.
- Live check not run: no debug Chromium was listening on 127.0.0.1:9228 (or any 92xx port) on
  this host, so the claim-editor gestures, download, and placement hand-off are unverified in Wplace.
