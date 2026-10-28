# #669 Lift the 16 MP template size cap

## Summary
Templates over 16 MP are refused at import, recipe, `.caelestis` file, and Wplace mirror
boundaries. Rendering, mismatch, and residency already scale by tile, so drop the area caps.

## Acceptance criteria
- [ ] A PNG over 16 MP imports, renders, and saves.
- [ ] Area caps gone; per-side `WORLD_PIXELS`, file-byte caps, and resident budget stay.

## TODOs
- [ ] Remove the area caps from import, recipe, `.caelestis` file, and native mirror paths.
- [ ] Update the recipe test that used 5000x5000 as an invalid size.
- [ ] Changeset for userscript.
- [ ] Prove in Chromium: import a >16 MP PNG on Wplace, see it render.

## Notes
- Kept: backend 400-tile upload cap, server-sync 64 M-pixel dense assembly bound (hostile server).
- GPU store chunks by MAX_TEXTURE_SIZE and its cache budget is soft for visible templates.
