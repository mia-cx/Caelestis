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
- Built on `feat/template-studio`, one PR per slice merged into it, then one root PR to `main`.

## Windows
| Window | Ditherette web source | Contents |
| --- | --- | --- |
| Studio bar | AppBar, ExportStrip | Name, status, Original toggle, Windows menu, Cancel, Save, Replace |
| Source | (new) | File, clipboard, URL; crop |
| Dimensions | OutputPanel | Output size, lock ratio, resize filter, anchor |
| Palette | PalettePanel (no custom palettes) | Scopes, swatch toggles, counts |
| Colour space | ColorSpacePanel | Matching space |
| Dither | DitherPanel, DitherAlgorithmSelect, AdaptivePlacementControls | Algorithm, strength, serpentine, placement |
| Effects | PipelinePanel, EffectControls, effects/* | Ordered effect layers, one window per layer, masks |
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

## Notes
- Wplace's CSP allows `blob:` scripts and `wasm-unsafe-eval`, and sets no connect-src. WebGPU works
  in the page (tested on Apple metal-3).
- GPU and CPU results differ, but each is deterministic run to run. The recipe records the engine
  that produced the saved pixels.
- Server versions must keep the template's dimensions, so Replace mode locks the output size.
