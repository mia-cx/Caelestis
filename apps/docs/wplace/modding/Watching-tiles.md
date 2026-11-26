---
title: Watching tiles
description: Follow Wplace's map tiles from request to texture to know which tiles loaded, when they changed, and what pixels they hold.
order: 5
tags: [source/caelestis, pawtect/none]
---

**Pawtect:** none. Wplace's own tile requests are in Pawtect's URL log anyway, and watching them adds nothing to it. Tile responses are never checked for tampering. Don't patch `json` or `text` on API responses while you are at it ([fetch](Page-fetch)).

Wplace's paint lives in 2048 × 2048 tiles of 1000 × 1000 pixels. Each is a PNG at:

```text
https://backend.wplace.live/files/s{season}/tiles/{x}/{y}.png
```

The season is `0` on 26 November 2026. [Get tile](api/pixels/Get-tile) documents the request. [Coordinates](Coordinates) converts between tiles, pixels and coordinates. Tiles have their own [rate limit](Rate-limits), and the CDN caches each one for 5 seconds.

## The path of a tile

1. MapLibre asks for the tile with `fetch`, from the `pixel-art-layer` raster source ([Map sources and layers](Map-sources-and-layers)).
2. Wplace's service worker answers first. It serves cached copies, draws the player's unsent draft pixels into the image, and turns a `404` into a transparent PNG ([ServiceWorkerMessage](Service-worker-messages)).
3. MapLibre reads the body with `arrayBuffer()`, builds a `Blob`, and decodes it with `createImageBitmap`.
4. MapLibre uploads the bitmap with `texImage2D`, or refreshes a pooled texture with `texSubImage2D` ([getContext](WebGL-context)).

Hook the step that gives you what you need:

| You want | Hook | Notes |
| --- | --- | --- |
| Which tiles are requested | [fetch](Page-fetch) | Match the URL against `/files/s\d+/tiles/(\d+)/(\d+)\.png` on `backend.wplace.live` |
| The PNG bytes | `response.clone()` in your fetch wrapper | Includes the service worker's drafts. A tile with no paint arrives as a transparent PNG. |
| Which tiles finished loading | `map.on('data', …)` with `event.sourceId === 'pixel-art-layer'` and `event.tile` | Public MapLibre API. No bytes. |
| Where a tile was drawn on screen | WebGL draw calls | See [Drawing overlays](Drawing-overlays) |

```ts
const TILE = /^\/files\/s(\d+)\/tiles\/(\d+)\/(\d+)\.png$/

const tileOf = (url: string) => {
  const parsed = new URL(url, location.href)
  if (parsed.origin !== 'https://backend.wplace.live') return null
  const match = TILE.exec(parsed.pathname)
  return match && { season: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
}
```

Decode the bytes yourself with `createImageBitmap` and an `OffscreenCanvas`, or a PNG decoder. Pixel colours map to Wplace's palette by RGB. Transparent pixels are unpainted.

## How tiles refresh

Wplace reloads its visible tiles on a timer: the client config sets `refreshIntervalMs: 6000`, and it calls `map.refreshTiles('pixel-art-layer')`. Each refresh re-downloads every visible tile. A paint or a draft change also triggers a refresh.

A mod can tell which tiles changed without decoding them. Each tile response carries an `ETag` and `Last-Modified` ([Get tile](api/pixels/Get-tile)).

Don't fetch tiles a second time when the page already has them. Reading what Wplace downloads costs no extra requests. Fetching your own copies doubles your users' tile traffic, and their IP shares one tile limit with Wplace.

## Caelestis's approach

Caelestis needs to know exactly which texture holds which tile, so it tags each step instead of cloning:

- It shadows `arrayBuffer` and `blob` on tile responses with own properties, and tags the buffer they return ([`tile-attribution.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/tile-attribution.ts)).
- It wraps the `Blob` constructor to carry the tag to the new `Blob`, and `createImageBitmap` to carry it to the bitmap.
- It watches `texImage2D` and `texSubImage2D` to carry it to the texture ([`gl-observer.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/gl-observer.ts)).
- It also wraps `map.refreshTiles` to reload only tiles whose `ETag` or `Last-Modified` changed, checked with `HEAD` requests ([`wplace-tile-refresh.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-tile-refresh.ts)). It reads the visible tiles from MapLibre's private `style.tileManagers['pixel-art-layer']._inViewTiles`.

None of these touch `json` or `text`, so none sets Tampered response.

## Related

- [Map sources and layers](Map-sources-and-layers)
- [Draft canvases](Draft-canvases)
- [Drawing overlays](Drawing-overlays)
