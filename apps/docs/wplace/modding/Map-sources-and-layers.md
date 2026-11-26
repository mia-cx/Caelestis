---
title: Map sources and layers
description: The MapLibre source and layer ids Wplace adds to its map, such as pixel-art-layer and pixel-hover, and where to insert your own layers.
tags: [source/caelestis, pawtect/none]
---

**Pawtect:** none. Pawtect reads no map style. Adding, moving or hiding layers sets no flag.

Read live with `map.getStyle()` after `style.load`, on 26 November 2026. The basemap has 115 layers. Wplace's own sources and layers sit on top of it.

## Sources

| Id | Type | What |
| --- | --- | --- |
| `pixel-art-layer` | `raster` | The painted canvas. Tiles from `https://backend.wplace.live/files/s0/tiles/{x}/{y}.png`, `minzoom` and `maxzoom` both 11, `tileSize` 550. |
| `pixel-hover` | `canvas`, `animate: true` | The crosshair over the hovered or selected pixel. |
| `hotspots-source` | `geojson` | Busy regions, from [`GET /map/hotspots`](api/pixels/Get-hotspots). |
| `openmaptiles` | `vector` | Basemap, from `https://maps.wplace.live/planet`. |
| `ne2_shaded` | `raster` | Natural Earth relief for low zooms, `maxzoom` 6. |

`tileSize` is MapLibre's display size, not the PNG's size. Each PNG is 1000 × 1000 pixels. With `tileSize` 550, one Wplace pixel covers one screen pixel at about zoom 11.86.

## Layers, bottom to top

| Id | Notes |
| --- | --- |
| basemap layers | From the `liberty` (light) or `fiord` (dark) style. |
| `pixel-art-layer` | Raster layer of the source with the same id. |
| `hotspots-halo`, `hotspots-layer` | Hotspot markers. |
| `pixel-hover` | The crosshair. Always on top. |
| `paint-preview-{random}` | Added while painting, one per draft overlay. The id ends in `Math.random()`, so match the `paint-preview-` prefix. Found in the client code, not seen live (it needs a signed-in player). |

Headquarters pins and other markers are DOM elements (`.maplibregl-marker`), not layers.

## Placing your layer

- Above the paint and below the crosshair: `map.addLayer(layer, 'pixel-hover')`. Caelestis draws its templates there.
- Below the paint: `map.addLayer(layer, 'pixel-art-layer')`.
- Find ids at runtime from `map.getStyle().layers`, or `map.style._order` if you also need custom layers. Don't hard-code a basemap layer id: the two themes' styles differ.

A theme switch calls `map.setStyle`, which removes every layer and source you added. Add yours again on each `style.load` ([Drawing overlays](Drawing-overlays)).

## Basemap styles

The style URL is `https://maps.wplace.live/styles/liberty` for the light theme and `https://maps.wplace.live/styles/fiord` for the dark one ([Get map style](api/map/Get-map-style)). Wplace builds it from the theme name, so `custom-winter` maps to `liberty` and anything else to `fiord` ([Theme](Theme)). Sprites and glyphs also come from `maps.wplace.live`.

## Caelestis and this note

- Caelestis's [`wplace-raster.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-raster.ts) names `pixel-art-layer`, `pixel-hover` and the `paint-preview-` prefix. Its comment says draft layers are named for their tile (`paint-preview-…-325,1783`). The current client names them with a random number. The prefix check still matches.
- Caelestis pauses the `pixel-hover` canvas source while nothing moves, because an animated canvas source redraws the whole map every frame ([`wplace-patches.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-patches.ts)).

## Related

- [map](Map)
- [Watching tiles](Watching-tiles)
- [Drawing overlays](Drawing-overlays)
