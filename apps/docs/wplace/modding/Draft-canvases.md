---
title: CanvasRenderingContext2D
description: Observe the 1000 × 1000 2D canvases Wplace draws a player's unsent draft pixels on, by wrapping putImageData and clearRect.
tags: [source/caelestis, pawtect/none]
symbol:
  kind: function
  name: CanvasRenderingContext2D.prototype.putImageData
  signature: "putImageData(imageData: ImageData, dx: number, dy: number, dirtyX?: number, dirtyY?: number, dirtyWidth?: number, dirtyHeight?: number): void"
  parameters:
    - { name: imageData, type: "ImageData", description: "The draft pixels Wplace writes." }
    - { name: dx, type: number, description: "Destination column on the tile canvas." }
    - { name: dy, type: number, description: "Destination row on the tile canvas." }
  returns: { type: "void" }
  source: https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/canvas-taps.ts
---

**Pawtect:** none. Watching canvas writes is invisible to Pawtect. Only reading is safe here: drafts become paints when the player presses Paint, so don't write to these canvases.

While a signed-in player paints, Wplace keeps their unsent pixels, the draft, on tile-sized 2D canvases: 1000 × 1000, one per tile with drafts. The same pixels go to the service worker as `previewPixels` ([ServiceWorkerMessage](Service-worker-messages)).

Each canvas is the source of one `paint-preview-` map layer, whose id ends in its tile ([Map sources and layers](Map-sources-and-layers)). Three things about them, from Caelestis's code and research:

- **They are upside down.** The source's corner coordinates run from the tile's bottom edge, so canvas row 0 is the tile's last row. Caelestis measured this on the live style: the layer for tile 325,1781 had its first corner at tile y 1782. Flip rows when you read one; columns are not reversed.
- **They upload every frame.** The sources animate, so MapLibre re-uploads every draft canvas on every frame, while Wplace writes to a canvas only when a pixel changes. Re-read a canvas after a write, not after an upload.
- **Transparent drafts are invisible.** Drafting Transparent writes alpha 0, which looks exactly like no draft. Only Wplace's crosshair over the pixel shows it ([Palette](Palette)).

A mod that wants the draft, for example to count how many pixels of a template the player has placed, can read it from either place:

| Source | Gives | Effort |
| --- | --- | --- |
| `previewPixels` messages to the service worker | The whole draft as a list: tile, pixel, season, RGBA colour | Wrap `ServiceWorker.prototype.postMessage` |
| The draft canvases | Each change, as a rectangle on a tile canvas | Wrap the 2D context methods below |

## Wrapping the 2D context

Caelestis wraps these methods on `CanvasRenderingContext2D.prototype` and `OffscreenCanvasRenderingContext2D.prototype`, and treats only 1000 × 1000 canvases as draft tiles ([`canvas-taps.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/canvas-taps.ts)):

- `putImageData`: a draft write. The `ImageData` and destination give the exact pixels.
- `clearRect` with an identity transform: erased draft pixels.
- `drawImage`, `fillRect`, `strokeRect`, `fill`, `stroke`, `fillText`, `strokeText`, `reset`, `clip`, and setting `width` or `height`: the canvas changed in a way that needs a full re-read.

Each wrapper calls the native method first and returns its result. Install them at document start on the page's prototypes.

## Not verified live

The draft canvases appear only for a signed-in player in Paint mode. This note's description comes from Caelestis's code and the client code. It was not observed on the live client on 26 November 2026.

## Related

- [How Wplace renders the map](Map-rendering)
- [Reading the paint UI](Reading-the-paint-UI)
- [Watching tiles](Watching-tiles)
- [getContext](WebGL-context)
