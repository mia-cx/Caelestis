---
title: Drawing overlays
description: Draw templates, guides or markers over the Wplace map with a MapLibre image layer, a custom WebGL layer, or a positioned DOM element.
order: 6
tags: [source/caelestis, pawtect/none]
---

**Pawtect:** none. An overlay that draws on its own layer sets no flag. Keep it from catching clicks meant for the map, and never forward synthetic clicks to the map in its place ([Anti-cheat](Anti-cheat)).

There are three ways to draw over the map. All need the [map](Map) except the last. Many overlay mods instead rewrite Wplace's tile PNGs with the template drawn in. [Layers versus tile compositing](Layers-versus-tile-compositing) compares the two, with measured costs, and builds a template layer end to end.

## 1. An image layer

The simplest overlay: a picture pinned to four corners. MapLibre draws it inside its own canvas, so it pans and zooms with the map.

```ts
const WORLD_PIXELS = 2048 * 1000

/** Longitude and latitude of a Wplace world pixel's top-left corner. */
const lngLatOf = (px: number, py: number): [number, number] => [
  (px / WORLD_PIXELS) * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / WORLD_PIXELS))) * 180) / Math.PI,
]

const addTemplate = (map: maplibregl.Map, url: string, x: number, y: number, width: number, height: number) => {
  map.addSource('my-template', {
    type: 'image',
    url,
    coordinates: [lngLatOf(x, y), lngLatOf(x + width, y), lngLatOf(x + width, y + height), lngLatOf(x, y + height)],
  })
  map.addLayer(
    { id: 'my-template', type: 'raster', source: 'my-template', paint: { 'raster-opacity': 0.6, 'raster-resampling': 'nearest' } },
    'pixel-hover',
  )
}

const install = () => {
  if (map.getSource('my-template') && map.getLayer('my-template')) return
  if (map.getLayer('my-template')) map.removeLayer('my-template')
  if (map.getSource('my-template')) map.removeSource('my-template')
  addTemplate(map, templateUrl, 1100_000, 671_000, 64, 64)
}
map.on('style.load', install)
if (map.isStyleLoaded()) install()
```

`x` and `y` are world pixels: tile × 1000 + pixel ([Coordinates](Coordinates)). `raster-resampling: nearest` keeps pixels sharp. Inserting before `pixel-hover` keeps Wplace's crosshair on top ([Map sources and layers](Map-sources-and-layers)).

## 2. A custom WebGL layer

For per-pixel effects, such as highlighting only the wrong pixels, add a custom layer. MapLibre calls it inside its render pass, with its own WebGL context.

```ts
map.addLayer(
  {
    id: 'my-layer',
    type: 'custom',
    renderingMode: '2d',
    onAdd(map, gl) { /* compile shaders, upload textures */ },
    render(gl, options) { /* draw with options.modelViewProjectionMatrix */ },
  },
  'pixel-hover',
)
```

Restore any WebGL state you change. Call `map.triggerRepaint()` when your data changes. Caelestis draws all its templates, markers and presence this way, in one stack of custom layers ([`gl/layer-stack.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/gl/layer-stack.ts)).

MapLibre rounds where it draws each tile by up to half a screen pixel, so a layer placed by projection alone can sit half a pixel off Wplace's art. Draw with the matrices MapLibre draws the tiles with instead ([Layers versus tile compositing](Layers-versus-tile-compositing)).

## 3. A DOM overlay

Without the map, or for UI that should not scale with it, position an element over the canvas. Follow the camera with `map.on('move', …)` and `map.project()`. Without the map you only have the URL's position at load ([URL parameters](URL-parameters)).

Put DOM overlays outside `.maplibregl-canvas-container`, or set `pointer-events: none`, so the player's clicks still reach the map.

## After a theme switch

Changing the theme calls `map.setStyle`. Wplace carries its own sources and layers into the new style, and on 26 November 2026 yours stayed too: a custom layer and an image layer both survived, in order ([How Wplace renders the map](Map-rendering)). MapLibre drops everything when it cannot diff two styles, though. That is why the `install` in the first example runs on every `style.load` and adds only what is missing.

## Related

- [Layers versus tile compositing](Layers-versus-tile-compositing)
- [Map sources and layers](Map-sources-and-layers)
- [Finding the map](Finding-the-map)
- [Theme](Theme)
