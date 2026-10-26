# #168 Template creation workspace: crop, process, place, and publish in one view

## Summary
A template studio over the live Wplace map. An image from a file, the clipboard, or a URL opens the
studio: the processed draft is drawn on the map at its placement, and floating tool windows carry
every Ditherette web control. The draft saves as a new Local or server template, or, as a separate
explicit action, as a new version of an existing server template. Processing runs through the
published `ditherette` package, on the GPU when the browser has one, off the UI thread otherwise.

## Decisions
- The live map is the preview. Placement is dragging the draft. Ditherette's A/B comparison becomes
  an Original toggle that draws the unprocessed source in the draft's place.
- Windows float over the map in Wplace's look (classic and pixel): drag by the title bar, collapse,
  close, snap to screen edges, reopen from a Windows menu. Positions persist per browser.
- A full port of Ditherette web's controls, minus custom palettes. The palette window keeps the
  Wplace palette with per-swatch toggles and the All, Free, Premium, and Owned scopes.
- Selection dropdowns are plain lists of names. No preview canvases inside menus.
- Ditherette is the published npm package. The userscript build inlines its WASM and its GPU glue,
  which the package otherwise finds through `import.meta.url`.
- On phones (40rem and narrower) the windows share one sheet along the bottom, one window at a time;
  tapping the open tab folds the sheet to uncover the map.
- Undo and redo cover every edit to the result, a burst of one kind (a slider drag) as one step.
  They use Caelestis's undo and redo shortcuts while the studio is open. A new image starts a fresh
  history.
- Built on `feat/template-studio`, one PR per slice merged into it, then one root PR to `main`.

## Windows
| Window | Ditherette web source | Contents |
| --- | --- | --- |
| Studio bar | AppBar, ExportStrip | Name, status, undo, redo, Original toggle, Windows menu, Cancel, Save, Replace |
| Source | (new) | File, clipboard, URL; crop |
| Dimensions | OutputPanel | Output size, lock ratio, resize filter, anchor |
| Palette | PalettePanel (no custom palettes) | Scopes, swatch toggles, counts |
| Colour space | ColorSpacePanel | Matching space |
| Dither | DitherPanel, DitherAlgorithmSelect, AdaptivePlacementControls | Algorithm, strength, serpentine, placement |
| Effects | PipelinePanel, EffectControls, effects/* | Ordered effect layers above the selected layer's controls and mask |
| Scopes | ScopesPanel, scopes/* | Histogram, waveform, vectorscope, chromaticity |

## Slices
1. Studio shell: window foundation, studio element and controller, Ditherette 1.0 (GPU with CPU
   fallback), draft on the map with drag placement, Source and Dimensions windows, Save as Local,
   Cancel. Entry points from Import and the tree.
2. Palette and Colour space windows.
3. Dither window: every algorithm and its parameters, Adaptive placement.
4. Effects: `RecipeV2` in the Caelestis recipe, the layer list, every effect editor, masks.
5. Scopes window.
6. Save to a server and Replace template, undo and redo, keyboard and touch, Celeste fixture
   coverage, changesets.

## Acceptance criteria
- [x] File, clipboard, and URL inputs all enter the same editor state.
- [x] A new image starts at identity scale and can be cropped, transformed, and placed against the live canvas.
- [x] Crop, palette, quantisation, dither, placement, and preview remain editable in one view.
- [x] The default palette contains the current account's unlocked colours, with All, Free, Premium, and Owned presets.
- [ ] Ditherette is consumed only through its published typed npm/WASM entrypoint. Waiting on the
  1.0.0 publish; the branches build against a local 1.0.0 tarball and leave `pnpm-lock.yaml` out.
- [x] Processing does not freeze ordinary map and editor interaction.
- [x] The author can save as a new local or server template, subject to the destination's existing permissions.
- [x] Replace template is a separate explicit action that creates a new server version and preserves authorship and version history.
- [x] Cancel and failed processing leave existing templates untouched.
- [x] The Berrycamp Celeste fixtures cover crop, palette, processing, placement, create, and replace paths in tests.
- [x] The editor works with pointer, touch, and keyboard input at the same responsive widths as the current userscript UI.

## Open
- The Original toggle: needs a draft renderer for RGBA pixels.
- Ditherette web extras not yet ported: the curve eyedropper, the curves backdrop grid, Show mask.
- A locked palette fit keeps its curves when the image or crop changes; Ditherette web re-analyses.
- Without Ditherette (no WebAssembly) the studio cannot process; a nearest-colour fallback is possible.
- The userscript grows by about 4.5 MB with Ditherette's WASM inlined.

## Notes
- Wplace's CSP allows `blob:` scripts and `wasm-unsafe-eval`, and sets no connect-src. WebGPU works
  in the page (tested on Apple metal-3).
- GPU and CPU results differ, but each is deterministic run to run. The recipe records the engine
  that produced the saved pixels.
- Server versions must keep the template's dimensions, so Replace mode locks the output size.
