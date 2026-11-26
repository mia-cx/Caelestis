---
title: Map sources and layers
description: The MapLibre source and layer ids Wplace adds to its map, such as pixel-art-layer and pixel-hover, and where to insert your own layers.
tags: [source/caelestis, pawtect/none]
---

**Pawtect:** none. Pawtect reads no map style. Adding, moving or hiding layers sets no flag.

Read live with `map.getStyle()` after `style.load`, on 26 November 2026. The light theme's style has 115 layers: 111 from the basemap and Wplace's own 4 on top. The dark basemap has 48.

## Sources

| Id | Type | What |
| --- | --- | --- |
| `pixel-art-layer` | `raster` | The painted canvas. Tiles from `https://backend.wplace.live/files/s0/tiles/{x}/{y}.png`, `minzoom` and `maxzoom` both 11, `tileSize` 550, or 400 in a window 640 CSS pixels wide or less. |
| `pixel-hover` | `canvas`, `animate: true` | The crosshair over the hovered or selected pixel. |
| `hotspots-source` | `geojson` | Busy regions, from [`GET /map/hotspots`](api/pixels/Get-hotspots). |
| `openmaptiles` | `vector` | Basemap, from `https://maps.wplace.live/planet`. |
| `ne2_shaded` | `raster` | Natural Earth relief for low zooms, `maxzoom` 6. |

`tileSize` is MapLibre's display size, not the PNG's size. Each PNG is 1000 × 1000 pixels. With `tileSize` 550, one Wplace pixel covers one CSS pixel at about zoom 11.86, and with 400 at about zoom 12.32. Wplace picks the size from `innerWidth` when it adds the source.

## Layers, bottom to top

| Id | Notes |
| --- | --- |
| basemap layers | From the `liberty` (light) or `fiord` (dark) style. |
| `pixel-art-layer` | Raster layer of the source with the same id. |
| `hotspots-halo`, `hotspots-layer` | Hotspot markers. |
| `pixel-hover` | The crosshair. Always on top. |
| `paint-preview-{random}-{x},{y}` | Added while painting, one per tile with drafts, each backed by a canvas source ([Draft canvases](Draft-canvases)). The id holds `Math.random()` and, per Caelestis's code, ends in the tile, such as `-325,1783`. Match the `paint-preview-` prefix. Not seen live (it needs a signed-in player). |
| `highlight-area-{part}-{id}` | Highlighted areas. `part` is `fill`, `line-white`, `line-color` or `image-layer`. The fill sits below `pixel-art-layer`; the others go on top. From Caelestis's research on 24 September 2026; none was present on a fresh load. |

Headquarters pins and other markers are DOM elements (`.maplibregl-marker`), not layers.

## Placing your layer

- Above the paint and below the crosshair: `map.addLayer(layer, 'pixel-hover')`. Caelestis draws its templates there.
- Below the paint: `map.addLayer(layer, 'pixel-art-layer')`.
- Find ids at runtime from `map.getStyle().layers`, or `map.style._order` if you also need custom layers. Don't hard-code a basemap layer id: the two themes' styles differ.

Don't move layers from a `styledata` listener. Wplace moves its `highlight-area-*` layers there on every style update, and the two would answer each other forever ([How Wplace renders the map](Map-rendering)).

A theme switch calls `map.setStyle`. Wplace carries over every non-canvas source that is not part of the basemap, with its layers, and MapLibre keeps custom layers. On 26 November 2026 a custom layer and an image layer both survived the switch in order. Still check on each `style.load` and add what is missing, because MapLibre drops everything when it cannot diff two styles ([Drawing overlays](Drawing-overlays)).

## Basemap styles

The style URL is `https://maps.wplace.live/styles/liberty` for the light theme and `https://maps.wplace.live/styles/fiord` for the dark one ([Get map style](api/map/Get-map-style)). Wplace builds it from the theme name, so `custom-winter` maps to `liberty` and anything else to `fiord` ([Theme](Theme)). Sprites and glyphs also come from `maps.wplace.live`.

## Caelestis and this note

- Caelestis's [`wplace-raster.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-raster.ts) names `pixel-art-layer`, `pixel-hover` and the `paint-preview-` prefix. It reads each draft layer's tile from the end of its id ([`draft-pixels.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/draft-pixels.ts)).
- Caelestis pauses the `pixel-hover` canvas source while nothing moves, because an animated canvas source redraws the whole map every frame ([`wplace-patches.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-patches.ts)).
- Caelestis keeps its own layers in a fixed order around these ([Layers versus tile compositing](Layers-versus-tile-compositing)).

## Related

- [map](Map)
- [How Wplace renders the map](Map-rendering)
- [Watching tiles](Watching-tiles)
- [Drawing overlays](Drawing-overlays)
