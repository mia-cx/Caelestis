---
title: Get a map tile
description: Download one 1000 × 1000 canvas tile as a PNG, cached for 5 seconds.
tags:
  - source/client
  - source/probe
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /files/s{season}/tiles/{tileX}/{tileY}.png
  auth: none
  parameters:
    - name: season
      in: path
      required: true
      type: integer
      example: 0
      description: Season. `0` is the current and only season.
    - name: tileX
      in: path
      required: true
      type: integer
      example: 1037
      description: Tile column, 0 to 2047.
    - name: tileY
      in: path
      required: true
      type: integer
      example: 704
      description: Tile row, 0 to 2047.
  responses:
    "200":
      description: The tile as an indexed PNG, 1000 × 1000, at 1, 2, 4 or 8 bits per pixel, with a palette of its own.
      contentType: image/png
    "304":
      description: Unchanged, for a conditional request with a matching `If-None-Match`. Only possible outside a page, since the browser preflight for that header fails.
    "404":
      description: The tile has never been painted, or is outside the map. The body is an HTML error page.
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The canvas is 2048 × 2048 tiles of 1000 × 1000 pixels each, on a Web Mercator map at zoom 11. Tile coordinates run from 0 to 2047. The client reloads visible tiles every 6 seconds above zoom 12.5, and every 15 seconds at or below it.

The PNG's palette belongs to the tile: its indices are not Wplace's colour ids, and its bit depth shrinks with the number of colours. Match pixels by RGB ([[Palette]]).

The response carries `cache-control: s-maxage=5, must-revalidate, no-store`. The CDN caches a tile for 5 seconds, and browsers don't cache it at all. Each tile carries an `ETag` and `Last-Modified`. From a page on wplace.live:

- `HEAD` works as a simple CORS request, and `Last-Modified` and `Content-Length` are readable.
- `ETag` is not exposed to scripts.
- `If-None-Match` needs a CORS preflight, and the preflight answers `405`.

Outside a browser, `If-None-Match` with the tile's `ETag` answers `304`. Tile 2048 and above answer `404`, as does `s1`. All checked on 26 November 2026.

The map renderer fetches tiles outside the API client, so Pawtect never inspects them. [[Coordinates]] shows how to turn a latitude and longitude into a tile.

Counts toward the tile [[Rate-limits|rate limit]].

Related: [[Get-pixel]], [[Get-random-tile]], [[Watching-tiles]], [[Palette]].
