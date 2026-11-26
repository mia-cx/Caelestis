---
title: How Wplace renders the map
description: How Wplace draws its tiles with MapLibre, how often it refreshes them, where it rounds, and how much it renders while nobody touches the map.
tags: [source/caelestis, source/client, pawtect/none]
---

**Pawtect:** none. Nothing here is checked. Reading the map's render state and tile list sets no flag.

What a mod drawing on the map needs to know about how Wplace draws it. Checked against the live client on 26 November 2026, except where a finding is dated otherwise.

## The renderer

Wplace draws with MapLibre GL JS 5.21.1, in one WebGL2 context on `canvas.maplibregl-canvas` ([getContext](WebGL-context)). The painted canvas is one raster source and layer, `pixel-art-layer`, between the basemap and Wplace's crosshair ([Map sources and layers](Map-sources-and-layers)).

## Tiles

- Every tile is a zoom-11 Web Mercator tile: the source's `minzoom` and `maxzoom` are both 11. Further out, MapLibre draws no tiles. Further in, it scales the zoom-11 tiles up.
- The source's `tileSize` depends on the window. It is 550 when `innerWidth` is over 640 CSS pixels and 400 otherwise, decided when the source is added. One Wplace pixel covers one CSS pixel at zoom 11.86 with 550, and at zoom 12.32 with 400.
- Wplace keeps rotation and pitch off. Across 234,574 projection-matrix uploads Caelestis recorded in August 2026, including a two-finger twist under touch emulation, every off-diagonal term was zero. Treat it as a product decision that can change.

## Where MapLibre rounds

While the map stands still, MapLibre snaps each raster tile to whole device pixels. While it moves, it does not. The switch is `painter.options.moving`. So a tile's on-screen position differs from `map.project()` of its corner by up to half a device pixel once the map settles. Measured at zoom 12.37, 1440 × 800, DPR 1: the snapped corner sat 0.30 px left and 0.47 px up from the projected one.

A layer placed by projection agrees with the art during a pan and shows a one-pixel seam after it. [Layers versus tile compositing](Layers-versus-tile-compositing) shows how to draw with the same matrices MapLibre uses.

## Refresh

Wplace reloads its tiles on a timer. The client config sets `refreshIntervalMs: 6000`.

- Above zoom 12.5 the timer runs every 6 seconds. At or below it, every 15 seconds (2.5 × 6).
- It runs only while `document.visibilityState` is `visible`.
- Each run calls `map.refreshTiles('pixel-art-layer')` with no tile list. MapLibre re-downloads, re-decodes and re-uploads every visible tile, changed or not, and resets its off-screen tile cache.

On 24 September 2026 over Paris at zoom 12.8, that was 20 tile downloads, 4,048 KB, per idle minute. A single busy tile left on screen costs about 270 MB per hour. [Watching tiles](Watching-tiles) shows how to tell which tiles changed.

Paint and drafts trigger refreshes too:

- A paint the server accepts makes the service worker reply `refreshPixelArt`, and the page reloads its tiles ([ServiceWorkerMessage](Service-worker-messages)).
- From Caelestis's research on 24 September 2026: with the default non-opaque art setting, each draft pixel placed or erased posts `previewPixels` to the service worker and reloads every visible tile. The worker decodes each tile, draws the drafts in and re-encodes it, including tiles with no drafts. One re-encoded tile was 1.59 MB, against 218 KB from the server.

## Drafts

While a signed-in player paints, Wplace adds one `paint-preview-` layer per tile with drafts, backed by a canvas source. The canvas holds the drafted pixels ([Draft canvases](Draft-canvases)). These sources animate, so the map renders every frame while any draft exists.

## Rendering while idle

From Caelestis's research on 24 September 2026, in a background tab with focus emulation, 1440 × 900, DPR 1, over Paris with nobody touching the map:

| What | Measured |
| --- | --- |
| Main-thread work | 5.6 s per 10 s |
| Draw calls | about 445 per frame, at 60 frames per second |
| `triggerRepaint` calls | 18,010 per minute |

Three causes, all in Wplace's client:

1. **The crosshair animates forever.** `pixel-hover` is a MapLibre canvas source added without `animate: false`. A playing canvas source keeps the map rendering every frame and re-uploads its texture each time. Hovering only moves its coordinates, which already asks for a frame.
2. **The highlight layers chase each other.** A `styledata` listener moves the `highlight-area-*` layers on every style update. Each move is itself a style update. Two of the line layers leapfrog each other to the top, so the loop never settles. Any style change starts it: the art opacity slider, a theme switch, or a mod adding a layer. MapLibre also restarts its sky transition on each style change, which keeps the map dirty.
3. **Hidden markers animate.** The event marker's CSS animations keep running at `opacity: 0`.

What this means for a mod:

- Your custom layer's `render` runs on every one of those frames. Keep it cheap, and do nothing when nothing changed.
- Don't move layers from a `styledata` listener. Wplace's listener answers each move with its own, and the two take turns for the life of the tab.
- Don't rely on frames you didn't ask for. If Wplace or another mod stops the idle rendering, a mod that waited for "the next frame" waits forever. Call `map.triggerRepaint()` when you need one.

Caelestis pauses the crosshair source, skips highlight moves that change nothing, and pauses hidden marker animations ([`wplace-patches.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-patches.ts)). Measured over one idle minute, main-thread time fell from 24.7 s to 1.25 s, and `triggerRepaint` calls from 18,010 to 7. It leaves the draft sources playing, because they show placed pixels.

## Theme switch

Switching theme calls `map.setStyle(url, { transformStyle })` ([Theme](Theme)). The transform keeps every source that is not a canvas source and not part of the previous basemap, and every layer that uses one, and appends them after the new basemap's layers. MapLibre then diffs the old style against the new one, so custom layers stay too.

The light basemap has 111 layers, and the dark one 48. In the light theme Wplace hides the basemap's `poi_*`, `building`, `building-3d` and some `landuse_*` layers.

## Context loss

The map can lose its WebGL context. Every texture, buffer and program you made dies with it. Listen for `webglcontextlost` and `webglcontextrestored` on the map, and rebuild your GL objects after a restore. Never reuse objects from the lost context. Caelestis forced a loss and restore in November 2026, and its overlay came back once it had rebuilt them.

## Related

- [Layers versus tile compositing](Layers-versus-tile-compositing)
- [Map sources and layers](Map-sources-and-layers)
- [Watching tiles](Watching-tiles)
- [getContext](WebGL-context)
