# Template studio

The map is the canvas. The draft draws where the template will go, and everything about its place, size and crop is edited there; the windows hold the settings that have no place on the map.

## On the map

The draft carries a handle on every corner and edge (`apps/userscript/src/templates/studio-frame.ts`). Corners keep its proportions and edges stretch one side; Shift swaps the two, live mid-drag. Dragging inside the draft moves it, as any template moves.

Crop mode, from the bar's Crop button, lays the whole source image over the map at the draft's scale, aligned so the applied crop covers the draft, dims everything outside the crop being drawn, and gives it the same handles, free unless Shift holds its proportions. Inside the crop drags it; elsewhere on the image draws a new one. Nothing reprocesses until Apply (or Enter); Cancel (or Escape) drops the draft crop. Applying keeps what stays of the image where it was on the map. When the whole image is not on screen, entering crop mode frames it. A replacement keeps its template's size, so it has no size handles and its crop keeps the template's proportions.

Handles are 10px squares with a 24px hit target (44px on coarse pointers) in Caelestis's selection blue, over a dark halo so they read on any artwork.

## Bar

The bar names the template, reads out its size and colour count in a fixed-width slot, and holds Crop, undo/redo, the Panels menu, Cancel and Save, each group set off by a hairline. In crop mode it becomes the crop bar: X, Y, W and H of the crop being drawn, Whole image, Trim (when transparency surrounds the image), Cancel and Apply crop. At phone width it wraps to three rows: name and Save; tools and Cancel; the readout.

## Windows

Body text is 0.875rem; labels use the text colour and only hints step back to muted. Field rows share a 5.75rem label column. Titled groups inside a window (`.section`) sit under a hairline. A control shows only when the current settings use it: Anchor only for filters other than Area, Dither's strength, placement, adaptive sampling and serpentine only for the algorithms they change. Before an image loads, size and position fields stay in place but empty.

Each window leads with what most templates need and folds the rest under More options, which remembers its state per window for the page's life. Size shows width and height side by side, Keep proportions and a percentage scale; resampling, anchor and position fold away, since the handles and dragging do them by hand. Colours shows the presets and swatches; matching and transparency fold away. Dither shows the algorithm and its strength; placement, its sampling, and the scan toggles fold away.

Image is a compact summary of the image with the three ways to load another; an image dropped anywhere over the studio loads too. The default layout docks Image, Size and Effects (folded to its title) at the start edge, and Colours above Dither at the end.
