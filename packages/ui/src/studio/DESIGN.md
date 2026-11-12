# Template studio

The map is the canvas. The draft draws where the template will go, and everything about its place, size and crop is edited there; the windows hold the settings that have no place on the map.

## On the map

The draft carries a handle on every corner and edge (`apps/userscript/src/templates/studio-frame.ts`). Corners keep its proportions and edges stretch one side; Shift swaps the two, live mid-drag. Dragging inside the draft moves it, as any template moves.

The image itself shows only on the map; no window previews it. Before there is one, a card in the middle of the map offers a file, the clipboard or a web address, and an image dropped or pasted anywhere loads too. A new draft lands in the middle of the view at any zoom.

Crop mode, from the bar's Crop button, lays the whole source image over the map at the draft's scale, aligned so the applied crop covers the draft, dims everything outside the crop being drawn, and gives it the same handles, free unless Shift holds its proportions. Inside the crop drags it; elsewhere on the image draws a new one. Under the crop, as in Ditherette, a small card holds its X, Y, W and H and Apply, Content (crop to the opaque pixels), Reset (the whole image) and Cancel, centred on the crop and kept on screen. Nothing reprocesses until Apply (or Enter); Cancel (or Escape) drops the draft crop. Applying keeps what stays of the image where it was on the map. When the whole image is not on screen, entering crop mode frames it with room below for the card. A replacement keeps its template's size, so it has no size handles and its crop keeps the template's proportions.

Handles are 10px squares with a 24px hit target (44px on coarse pointers) in Caelestis's selection blue, over a dark halo so they read on any artwork.

## Bar

The bar names the template, reads out its size and colour count in a fixed-width slot once there is an image, and holds Replace image (the same three ways to load one, in a popover), Crop (pressed while cropping), undo/redo, the Panels menu, Cancel and Save, each group set off by a hairline. Save waits while a crop is being drawn. At phone width it wraps: name and Save; Replace image and Crop; undo/redo and Cancel; the readout.

## Windows

Body text is 0.875rem; labels use the text colour and only hints step back to muted. Every window lays out the same way (`StudioStyles.svelte`):

- A named setting is a `.field-row`: its label in a 5.75rem column, its control after, so controls line up across rows and windows. Its hint, if any, runs the full width below.
- A yes/no setting is a switch row (`SwitchRow.svelte`): the label, then the switch at the row's end, its hint below. Clicking the label flips it.
- A choice among a few sits in `.choices`, each choice as wide as its label needs and the rest shared out, bevelled in pixel style: Palette's presets, a channel, the scopes to show, an effect's curves.
- Buttons that act on the rows above sit in `.row-actions`, in the controls' column.
- What the window itself shows (swatches, the effect layers, graphs, the scope) spans the width.
- A titled group (`.section`) sits under a hairline.

A select's chosen option ends in an ellipsis before its caret (`foundations/select-face.ts`). Number fields have no spinner, leaving their room to the digits. A control shows only when the current settings use it: Anchor only for filters other than Area, Dither's strength, placement, adaptive sampling and serpentine only for the algorithms they change. Before an image loads, size and position fields stay in place but empty.

Each window leads with what most templates need and folds the rest under More options, which remembers its state per window for the page's life. Size shows its scale, then width and height, Keep proportions, Reset aspect ratio (live once width and height scale the image unequally; it scales both as the longer side is), and how it resamples, with the anchor for filters that use one; its exact position folds away, since dragging on the map does it by hand. Palette shows the presets and swatches: which colours the template may use. Colour shows how each pixel picks among them (matching) and how source transparency becomes pixels, with nothing folded. Dither shows the algorithm and its strength; placement, its sampling, and the scan toggles fold away.

Every window floats over the map; none is docked. Every panel has a tab with its own close button, even alone, with the front tab underlined in the accent colour; tabs and their buttons are square in pixel style. Dragging a tab moves that panel: out into a window of its own, beside another panel, or behind it as a tab. Dragging the rest of any header, or the tab of a window's only panel, moves the whole window with every panel in it, and brings it in front. A window keeps its whole width and its title bar on screen, and stops above Wplace's bottom buttons. Its panels keep their whole height; when they outgrow that room, the window scrolls as one, never a panel inside it.

Sliders are Caelestis's own (`foundations/SliderStyles.svelte`), as in its settings: Wplace's framed track and bevelled thumb in pixel style.

The default layout is Ditherette's: Size and Dither tabbed over Palette and Colour at the start edge, Effects at the end.
