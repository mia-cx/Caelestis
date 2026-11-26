---
title: map
description: The MapLibre GL JS 5 map instance that renders the Wplace world map, what it exposes, and which parts are private and unstable.
tags: [source/caelestis, pawtect/none]
symbol:
  kind: variable
  name: map
  signature: "const map: maplibregl.Map  // MapLibre GL JS 5.21.1, not on any global"
  members:
    - { name: getCanvas, kind: method, signature: "getCanvas(): HTMLCanvasElement", description: "The WebGL canvas, `canvas.maplibregl-canvas`, inside `div#map`." }
    - { name: getCenter, kind: method, signature: "getCenter(): LngLat", description: "The camera centre. Convert to Wplace pixels with the zoom-11 Web Mercator formula in [[Coordinates]]." }
    - { name: getZoom, kind: method, signature: "getZoom(): number", description: "MapLibre zoom. Wplace's own tiles are zoom 11." }
    - { name: project, kind: method, signature: "project(lngLat: LngLatLike): Point", description: "Screen position of a longitude and latitude, in CSS pixels relative to the canvas." }
    - { name: unproject, kind: method, signature: "unproject(point: PointLike): LngLat", description: "The longitude and latitude under a screen point. Wplace picks its paint target the same way." }
    - { name: jumpTo, kind: method, signature: "jumpTo(options: JumpToOptions): this", description: "Move the camera at once. `flyTo` and `easeTo` animate. None of them rewrites the URL." }
    - { name: on, kind: method, signature: "on(type: string, listener: (event) => void): this", description: "Map events. Wplace itself listens to `move`, `moveend`, `zoom`, `click`, `mousemove`, `mouseout`, `dragstart`, `dragend`, `load`, `style.load`, `data`, `terrain` and `projectiontransition`." }
    - { name: addLayer, kind: method, signature: "addLayer(layer: LayerSpecification | CustomLayerInterface, beforeId?: string): this", description: "Add your own layer. See [[Drawing-overlays|Drawing overlays]]." }
    - { name: getSource, kind: method, signature: "getSource(id: string): Source | undefined", description: "Wplace's sources are listed in [[Map-sources-and-layers|Map sources and layers]]." }
    - { name: refreshTiles, kind: method, signature: "refreshTiles(sourceId: string, tiles?: { x: number; y: number; z: number }[]): void", description: "Reload a raster source's tiles. Wplace calls it for `pixel-art-layer` on a timer." }
    - { name: triggerRepaint, kind: method, signature: "triggerRepaint(): void", description: "Ask for a frame, for example after your custom layer's data changed." }
    - { name: setStyle, kind: method, signature: "setStyle(style: string | StyleSpecification, options?: StyleSwapOptions): this", description: "Wplace calls it with a `transformStyle` when the theme changes, which carries your image and raster sources and their layers into the new style. Custom layers survive MapLibre's style diff. A full style rebuild can still drop what you added." }
    - { name: style, kind: property, signature: "style: Style", description: "Private. `style._order` lists draw order with custom layers, `style._layers` holds layers by id, and `style.tileManagers` holds per-source tile state. Read defensively." }
    - { name: painter, kind: property, signature: "painter: Painter", description: "Private. `painter.transform.calculatePosMatrix()` gives a tile's matrix. Read defensively." }
  source: https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/map-handle.ts
---

**Pawtect:** none. Pawtect reads no map state. Calling camera methods such as `jumpTo` sets no flag. Dispatching a synthetic `click`, `touchstart` or `pointerdown` at the map marks automated clicks in every later token: see [Anti-cheat](Anti-cheat).

Wplace draws its world with [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) 5.21.1, bundled into one chunk. The instance is the whole public MapLibre API, plus MapLibre's private fields. Confirmed on the live client on 26 November 2026: `map.version` is `"5.21.1"`, the container is `div#map`, and the constructor's name is minified.

## Reaching it

The map is on no global, no DOM node and no module export. Two ways in, both at document start:

1. Catch it while it is built. MapLibre assigns `this._canvasContainer` in its constructor, and a setter on `Object.prototype` sees that assignment. See [Finding the map](Finding-the-map).
2. Catch [WplaceState](Wplace-state) and read its `map` property. On the live client, `state.map` is the same object.

## When it is ready

| Moment | What works |
| --- | --- |
| Constructed (~250 ms) | `on`, `getCanvas`, camera getters. `getStyle` and `getProjection` throw, because the style has not loaded. |
| `style.load` (~580 ms) | Sources, layers and `addLayer`. Fires again after every `setStyle`. |
| `load` (~3.4 s) | First tiles drawn. |

Listen for `style.load` in a microtask after you catch the map, then check `map.style?._loaded` in case it already fired. On every `style.load`, add only the sources and layers that are missing: a theme switch usually keeps yours, but a full style rebuild drops them ([Theme](Theme)).

## Stability

- Public MapLibre methods are stable while Wplace stays on MapLibre 5.
- `_canvasContainer` and the other underscore fields are MapLibre internals. They are not minified, but a MapLibre update can rename them.
- `style.tileManagers` is new in MapLibre 5. Older versions called it `sourceCaches`.
- Wplace's source and layer ids are Wplace's own and can change in any release.

## Related

- [Map sources and layers](Map-sources-and-layers)
- [Watching tiles](Watching-tiles)
- [URL parameters](URL-parameters)
