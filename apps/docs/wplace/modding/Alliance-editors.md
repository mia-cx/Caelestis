---
title: Alliance editors
description: How Wplace draws an alliance's headquarters, picture and banner editors, their coordinates and refresh, and where a mod can attach an overlay.
tags: [source/caelestis, source/client, pawtect/none]
---

**Pawtect:** none. Reading the editors' DOM and requests sets nothing. Overlays drawn on your own canvas inside an editor are not checked. Leave the editors' paint controls to the player ([Anti-cheat](Anti-cheat)).

An alliance has three drawing surfaces besides the world map: its headquarters (HQ), its picture and its banner. None of them is a MapLibre map. Each is a 2D pixel editor in a dialog. A mod that draws templates on the world map needs a second renderer for these.

From Caelestis's research on 30 August 2026, with a signed-in alliance member, updated by its fixes through November 2026 ([alliance drawing surfaces](https://github.com/mia-cx/Caelestis/blob/main/docs/research/19-alliance-drawing-surfaces.md)). The API module's requests were rechecked in chunk `BcgqpPa1.js` on 26 November 2026. The editors themselves need a signed-in alliance member, so their DOM was not rechecked.

## Finding the open editor

The editors have no URL of their own. They open as dialogs inside `/`, so `location.pathname` never changes. Wplace keeps closed dialogs in the DOM, so always start from `dialog[open]`:

| Editor | Stage |
| --- | --- |
| Headquarters | `dialog[open] [role="application"][aria-label="Headquarters canvas"]` |
| Picture or banner | `dialog[open] [role="application"][aria-label="Alliance asset canvas"]` |

The labels are the [message catalog](Message-catalog) entries `alliance_hq_canvas` and `alliance_asset_canvas`, so they change with the player's language. Look them up rather than hard-coding the English.

The stage does not say whether a picture or a banner is open. Every asset editor load requests `/alliance/assets/drafts/{draftId}/canvas` ([Get alliance asset canvas](api/my-alliance/assets/Get-alliance-asset-canvas)). The `metadataOnly=true` form answers with `assetType`, `width` and `height`. A picture is 64 × 64, and a banner 384 × 128.

Watch with a `MutationObserver` and reconcile at most once a frame. The editors mount and unmount on open, Back, Close and Svelte re-renders, and the same markup appears in windowed and full-screen modes.

## The artboard

Inside the stage, the element `.artboard-frame` carries the pan as a CSS `transform: translate(…)` and the zoom as its CSS `width` and `height`: the canvas size times the scale. Search for it inside the open stage only. Svelte's hashed classes on the same elements change between builds.

- **Headquarters:** the art is in one `.hq-tile-layer` canvas. Older builds used a container of 64 × 64 tile canvases ([#770](https://github.com/mia-cx/Caelestis/issues/770)). A full-size draft canvas follows it.
- **Picture and banner:** one canvas holds the art, in normal flow.

Tool and selection feedback sits on a separate, stage-sized canvas outside the frame, above everything.

A canvas you add inside `.artboard-frame`, sized to 100% of it, inherits Wplace's pan, zoom, fit and clipping for free. Place it after the art and before the draft canvas, so drafts cover your template the way they do on the world map. The frame's transform makes it a stacking context. An absolutely positioned canvas paints above the in-flow art canvas whatever its DOM order, so an outline meant to sit under the art needs `z-index: -1` ([#843](https://github.com/mia-cx/Caelestis/issues/843)).

Wplace's own **Alliance overlays** button is `dialog[open] [role="application"] > div > button[aria-label="Alliance overlays"]`, at the top left of the stage.

## Coordinates

Inside an editor, positive y is down, and a screen point maps to a pixel with plain 2D maths:

```ts
const pixelAt = (clientX: number, clientY: number, stage: DOMRect, offsetX: number, offsetY: number, scale: number, originX: number, originY: number) => ({
  x: Math.floor((clientX - stage.left - offsetX) / scale) + originX,
  y: Math.floor((clientY - stage.top - offsetY) / scale) + originY,
})
```

The editor zooms to at most 64 screen pixels per pixel.

**Headquarters coordinates are signed and centred.** A headquarters of size `n` spans `-n/2` to `n/2 - 1` on both axes, so `originX` and `originY` are the manifest's `bounds.minX` and `bounds.minY`. A 250 HQ spans −125 to 124, and a 2,000 HQ spans −1,000 to 999. Sizes are 250, 500, 750, 1,000, 1,500 and 2,000. An upgrade grows the canvas equally on every side, so store positions in signed coordinates, and they stay put.

Wplace's own alliance templates count their position from the canvas's top-left corner, not in signed coordinates. Wplace centres a new HQ template at `(width - w) / 2` and clamps it to the canvas ([#802](https://github.com/mia-cx/Caelestis/pull/802)).

**Picture and banner coordinates** start at `(0, 0)` in the top-left corner.

## Headquarters tiles and refresh

The headquarters is stored as 64 × 64 tiles. The client:

- requests the visible tiles, plus one tile of margin, with a [snapshot](api/alliances/Get-alliance-headquarters-snapshot) request that lists the tile versions it already has;
- gets back only the tiles that changed, in a binary format;
- keeps up to 1,296 tiles in a least-recently-used cache;
- aborts the previous request when the view moves, and drops a late answer for a tile it changed meanwhile;
- polls the [manifest](api/alliances/Get-alliance-headquarters-manifest) metadata and refreshes when `eventHwm` or the bounds change.

The member editor posts to `/alliance/headquarters/snapshot` with credentials. The public viewer posts to `/alliances/{id}/headquarters/snapshot` without them. Both send `{ minX, minY, maxX, maxY, knownTiles }`.

The snapshot body is little-endian:

```text
5 bytes  magic "WHQS1"
u16      tile size
i64      event high-water mark
u16      changed tile count
u16      removed tile count
per changed tile: i16 x, i16 y, i64 version, tileSize × tileSize palette indices (u8)
per removed tile: i16 x, i16 y
```

A full request for a 250 HQ returned three tiles in 12,343 bytes. The same request with those versions in `knownTiles` returned the 19-byte header alone.

## Picture and banner drafts

A picture or banner is edited as a draft. The editor reads the whole draft once as base64 palette indices, then polls `metadataOnly=true` for its revision every 6 seconds. A mod that treats each poll as a new draft tears down and rebuilds its overlay every 6 seconds ([#840](https://github.com/mia-cx/Caelestis/issues/840)). Key your state on the draft id.

## Painting

Each editor has its own paint drawer and palette. Its swatches are `button.game-color-swatch[aria-pressed]`, with no ids ([Reading the paint UI](Reading-the-paint-UI)). A headquarters has its own charges, separate from the world's. Paint requests go to [Paint headquarters](api/my-alliance/headquarters/Paint-headquarters) and [Paint alliance asset](api/my-alliance/assets/Paint-alliance-asset). They are the player's to send.

## Related

- [DOM landmarks](DOM-landmarks)
- [Palette](Palette)
- [Layers versus tile compositing](Layers-versus-tile-compositing)
