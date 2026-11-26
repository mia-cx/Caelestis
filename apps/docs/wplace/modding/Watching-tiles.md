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

## Reading a tile's pixels

Decode the bytes yourself with `createImageBitmap` and an `OffscreenCanvas`, or a PNG decoder. Checked on 26 November 2026:

- Tiles are indexed PNGs at 1, 2, 4 or 8 bits per pixel, depending on how many colours the tile holds. A decoder that only reads 8-bit PNGs fails on sparse tiles.
- Each tile has its own palette. Its indices are not Wplace's colour ids. Decode to RGBA and match by RGB ([Palette](Palette)).
- Fully transparent pixels are unpainted. Black and Transparent share the RGB `#000000`, so check alpha first.
- A tile nobody painted answers `404` with an HTML body from the origin. Wplace's service worker turns that into a 1 × 1 transparent PNG, so a tile that decodes to 1 × 1 is empty.

Do the work off the page's thread, and after Wplace has its bitmap. A tile is 4 MB of RGBA and a million pixels to match. Caelestis once did this inside Wplace's `createImageBitmap` promise, and Wplace could not draw a tile until it finished ([#729](https://github.com/mia-cx/Caelestis/issues/729)). It now reads each tile in a worker, from the body, and skips the read when the body's SHA-256 matches the last one.

Another mod may have rewritten the tile before you see it. Blue Marble, for example, hands Wplace every tile under its templates upscaled 3×, with its template drawn in. A tile that is not 1000 × 1000 is not Wplace's. Caelestis then fetches its own copy from a worker, where no page script can rewrite it ([#712](https://github.com/mia-cx/Caelestis/pull/712)). [Layers versus tile compositing](Layers-versus-tile-compositing) explains why it draws templates without rewriting tiles.

## How tiles refresh

Wplace reloads its visible tiles on a timer. The client config sets `refreshIntervalMs: 6000`. Above zoom 12.5 the timer runs every 6 seconds, and at or below it every 15 seconds. It runs only while the tab is visible. Each run calls `map.refreshTiles('pixel-art-layer')` with no tile list, which re-downloads every visible tile, changed or not. A paint or a draft change also triggers a refresh ([How Wplace renders the map](Map-rendering)).

A mod can tell which tiles changed without downloading them. Tiles are served `cache-control: s-maxage=5, must-revalidate, no-store`, so the browser never revalidates them on its own. From the page:

- `HEAD` is a simple CORS request. It answers with `Last-Modified` and `Content-Length`, both readable.
- `ETag` is sent but not exposed to page scripts.
- A conditional `GET` with `If-None-Match` needs a CORS preflight, and the preflight answers `405`.

So compare `Last-Modified` and `Content-Length` from a `HEAD`. `Last-Modified` has one-second resolution, so reload everything now and then as a safety net. Measured by Caelestis on 24 September 2026 over Paris: 18 `HEAD`s and 2 `GET`s, 405 KB, replaced 20 `GET`s, 4,048 KB, per idle minute. Assume a `HEAD` counts against the tile [rate limit](Rate-limits) like a `GET`. It was not measured separately.

Don't fetch tiles a second time when the page already has them. Reading what Wplace downloads costs no extra requests. Fetching your own copies doubles your users' tile traffic, and their IP shares one tile limit with Wplace. Anything that makes Wplace reload all visible tiles costs 20 to 50 requests at a normal view. Caelestis once did that on every pixel step of a template drag ([#724](https://github.com/mia-cx/Caelestis/issues/724)).

## Caelestis's approach

Caelestis needs to know exactly which texture holds which tile, so it tags each step instead of cloning:

- It shadows `arrayBuffer` and `blob` on tile responses with own properties, and tags the buffer they return ([`tile-attribution.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/tile-attribution.ts)).
- It wraps the `Blob` constructor to carry the tag to the new `Blob`, and `createImageBitmap` to carry it to the bitmap.
- It watches `texImage2D` and `texSubImage2D` to carry it to the texture ([`gl-observer.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/gl-observer.ts)).
- It also wraps `map.refreshTiles` to reload only tiles whose `ETag` or `Last-Modified` changed, checked with `HEAD` requests ([`wplace-tile-refresh.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-tile-refresh.ts)). It reads the visible tiles from MapLibre's private `style.tileManagers['pixel-art-layer']._inViewTiles`.

None of these touch `json` or `text`, so none sets Tampered response.

## Related

- [Palette](Palette)
- [How Wplace renders the map](Map-rendering)
- [Layers versus tile compositing](Layers-versus-tile-compositing)
- [Map sources and layers](Map-sources-and-layers)
- [Draft canvases](Draft-canvases)
- [Drawing overlays](Drawing-overlays)
