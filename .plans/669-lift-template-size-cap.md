# #669 Lift the 16 MP template size cap

## Summary
Templates over 16 MP are refused at import, recipe, `.caelestis` file, and Wplace mirror
boundaries. Rendering, mismatch, and residency already scale by tile, so drop the area caps.

## Acceptance criteria
- [x] A PNG over 16 MP imports, renders, and saves.
- [x] Area caps gone; per-side `WORLD_PIXELS`, file-byte caps, and resident budget stay.

## TODOs
- [x] Remove the area caps from import, recipe, `.caelestis` file, and native mirror paths.
- [x] Update the recipe test that used 5000x5000 as an invalid size.
- [x] Changeset for userscript.
- [x] Prove in Chromium: import a >16 MP PNG on Wplace, see it render.

## Notes
- Kept: backend 400-tile upload cap, server-sync 64 M-pixel dense assembly bound (hostile server).
- GPU store chunks by MAX_TEXTURE_SIZE and its cache budget is soft for visible templates.
- Chromium proof (~/.cache/caelestis-669): 6000x6000 refused before, imports/renders/reloads after;
  30000x30000 bomb fails with "could not be decoded"; 15000x15000 opaque hits the 64 Mi resident
  budget ("templates in memory exceed the pixel budget"). Tile-based residency is follow-up work.
