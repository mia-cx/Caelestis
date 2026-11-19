---
title: Overlay and painting
---

Change the overlay to see where each colour belongs. These controls adjust the view and preserve the stored artwork.

## Change the pixel style

Open **Appearance** in the Caelestis panel header. Choose a pixel preset. Use the sliders to adjust size, rounding, rotation, position within each cell and opacity.

These are the overlay pixels' settings. To move the artwork to another place on the map, use the template's **Move** action.

![Pixel presets and appearance sliders.](images/overlay/pixel-style.png)

Zoom in while adjusting them. At a distant zoom, small differences in shape are hard to see.

### Full pixels

Full pixels cover most of each map cell.

![Full overlay pixels with a contrast outline, viewed close enough to see individual cells.](images/overlay/full-pixel-outline.png)

### Corner pixels

Corner pixels leave the centre of the map cell visible.

![Corner overlay pixels with the underlying artwork visible between them.](images/overlay/corner-pixel-outline.png)

### Small pixels

Small pixels leave more of the canvas visible around each target colour.

![Small overlay pixels with contrast outlines.](images/overlay/small-pixel-outline.png)

**Contrast outline** adds an outline behind the overlay. It remains visible until Wplace artwork covers it.

## Change one template

Open the template display menu on the map rail. Expand **Pixels**, **Markers**, or **Colours** to change that group.

**Use defaults** keeps a group linked to the default appearance. Turn it off to give this template its own settings.

![The template display menu with its Pixels, Markers, and Colours sections.](images/overlay/template-display-menu.png)

## Show only the colours you need

In **Colours**, toggle palette swatches to show or hide those colours in the overlay. **Highlight the selected colour** follows your selection in Wplace's paint drawer.

![Colour visibility controls beside the resulting overlay.](images/overlay/colour-visibility.png)

## Find remaining work

1. Open Wplace's paint drawer and select a swatch. You can also use Wplace's picker on a template pixel. Caelestis briefly draws its exact colour under the picker. Wplace selects the swatch itself.
2. Check the remaining count in the palette. Middle-click a swatch to visit remaining pixels of that colour.
3. Hold Shift while painting to restrict the brush to unfinished pixels that need that colour. With Shift+Space, the brush waits where it would cross a skipped pixel.

![Wplace's picker used on a template strawberry, with the template's orange selected in the palette.](images/painting/native-colour-pick.png)

After the camera moves, move the mouse to update the paint target before using Space. The countdown above Wplace's paint button shows when your charges will be full.

![Full in 41:39:54 shown above Wplace's Paint button.](images/painting/charge-countdown.png)

The middle-click navigation order is in **Settings → Painting**. It searches the template under the viewport centre, or the nearest template if the centre is empty.

![The selected Wplace colour, remaining-work counts, and markers on the map.](images/painting/colour-work.png)

## Set up markers

Open **Appearance → Markers**.

| Control | What it marks |
| --- | --- |
| Mark mismatched pixels | Painted pixels whose colour differs from the template. |
| Include unpainted pixels | Adds blank pixels to the mismatch markers, below the configured remaining-work threshold. |
| Mark selected colour pixels | Unfinished pixels that need the colour selected in Wplace. |
| Dim other colours | Makes other colours' markers less prominent while following one colour. |

Each marker kind has colour and size controls. Enable the marker kind before adjusting its controls.

![Enabled mismatch-marker controls, including their colour and size.](images/overlay/marker-settings.png)

![Mismatch markers on artwork whose canvas colours differ from the template.](images/painting/mismatch-markers.png)

### Markers keep their screen size

Markers keep the same size on screen as you zoom. These two views show the same marker at different zoom levels.

![Selected-colour marker at a close map zoom.](images/painting/markers-close.png)

![The same marker at a wider map zoom, still the same size on screen.](images/painting/markers-wide.png)

## Keyboard controls

Press `Shift+/` to open the keyboard reference. It shows your current bindings for colour navigation, paint drafts, map peeking, overlay visibility, and opacity.

![The keyboard reference with the current bindings.](images/settings/shortcut-reference.png)

Change bindings in [Settings and shortcuts](Settings-and-shortcuts#keyboard-shortcuts). The colour cycling keys and keyboard draft submission have separate [Dangerous settings](Settings-and-shortcuts#dangerous-settings).
