# #168 Template creation workspace: crop, process, place, and publish in one view

## Summary
An image editor mode over the live Wplace map. An image from a file, the clipboard, or a URL opens
one workspace with tool windows for crop, placement, palette, colour matching, and dithering. The
processed result previews in place on the map and saves as a new Local or server template, or, as a
separate explicit action, as a new version of an existing server template. Processing runs through
the published `ditherette` package in a worker.

## Acceptance criteria
- [ ] File, clipboard, and URL inputs all enter the same editor state.
- [ ] A new image starts at identity scale and can be cropped, transformed, and placed against the live canvas.
- [ ] Crop, palette, quantisation, dither, placement, and preview remain editable in one view.
- [ ] The default palette contains the current account's unlocked colours, with All, Free, Premium, and Owned presets.
- [ ] Ditherette is consumed only through its published typed npm/WASM entrypoint.
- [ ] Processing does not freeze ordinary map and editor interaction.
- [ ] The author can save as a new local or server template, subject to the destination's existing permissions.
- [ ] Replace template is a separate explicit action that creates a new server version and preserves authorship and version history.
- [ ] Cancel and failed processing leave existing templates untouched.
- [ ] The Berrycamp Celeste fixtures cover crop, palette, processing, placement, create, and replace paths in tests.
- [ ] The editor works with pointer, touch, and keyboard input at the same responsive widths as the current userscript UI.

## TODOs
- [ ] Shared: `ditherette` template recipe processor (crop, output size, Ditherette RecipeV1), accepted by the backend.
- [ ] Userscript: bundle Ditherette's scalar WASM, run it in a worker with an in-process fallback; `processRecipe` replays ditherette recipes.
- [ ] Userscript: draft template slot rendered on the map, and draft placement through the move engine.
- [ ] UI: `TemplateEditor` element (drawer of tool windows, bar with name, status, Cancel, Save/Replace), responsive like ClaimMode.
- [ ] Userscript: editor controller (sources, crop, scale, palette scopes, matching, dither, placement, latest-wins processing, save create/replace, cancel).
- [ ] Entry points: Import routes plain images to the editor; "New from image" on folders; "Replace from image" on server templates.
- [ ] Tests: Berrycamp fixture through crop, palette, processing, placement, create, and replace.
- [ ] Changesets, browser verification with screenshots.

## Notes
- Ditherette 0.1.0-rc.0 is already on npm (`rc` tag) with types, scalar + threaded WASM. Nothing more
  needs publishing to start; the stable 0.1.0 is held on Ditherette's WebKit threads gate, which the
  scalar path does not use. Pinned exactly: the recipe's processor version names this build.
- Wplace's CSP allows `blob:` scripts and `wasm-unsafe-eval`, and sets no connect-src.
- Server versions must keep the template's dimensions, so Replace mode locks the output size.
