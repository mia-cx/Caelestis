---
title: Coordinates
description: Convert between latitude and longitude, Wplace tiles, and pixels inside a tile, on the zoom-11 Web Mercator canvas.
tags: [source/client, pawtect/none]
---

**Pawtect:** none. Coordinate maths runs in your own code and touches nothing Pawtect watches.

The canvas is a Web Mercator map at zoom 11: 2048 × 2048 tiles of 1000 × 1000 pixels, so the whole world is 2,048,000 pixels wide. A tile is named by `tileX` and `tileY`, and a pixel inside it by `x` and `y`, each from 0 to 999. A world pixel is tile × 1000 + pixel on each axis.

## From latitude and longitude

```ts
const WORLD_PIXELS = 2048 * 1000
const MAX_LATITUDE = 85.05112877980659 // the canvas's top and bottom edge
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const lat = (clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI) / 180
const px = ((((longitude + 180) / 360) % 1) + 1) % 1 * WORLD_PIXELS // 180° wraps to -180°
const py = clamp(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * WORLD_PIXELS, 0, WORLD_PIXELS - 1)

const tileX = Math.floor(px / 1000), x = Math.floor(px) % 1000
const tileY = Math.floor(py / 1000), y = Math.floor(py) % 1000
```

Berlin, at 52.52° N 13.40° E, falls on tile 1100/671.

## Back to latitude and longitude

```ts
const px = tileX * 1000 + x + 0.5 // the pixel's centre
const py = tileY * 1000 + y + 0.5
const longitude = (px / WORLD_PIXELS) * 360 - 180
const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / WORLD_PIXELS))) * 180) / Math.PI
```

## Where each form is used

- [Get tile](api/pixels/Get-tile) and [Get pixel](api/pixels/Get-pixel) take `tileX`, `tileY`, `x` and `y`.
- The [map](Map) camera and the [URL parameters](URL-parameters) use latitude, longitude and MapLibre zoom.
- [Drawing overlays](Drawing-overlays) places images in world pixels.
