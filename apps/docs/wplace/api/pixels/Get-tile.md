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
      description: The tile as a paletted PNG.
      contentType: image/png
    "404":
      description: The tile has never been painted, or is outside the map.
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The canvas is 2048 × 2048 tiles of 1000 × 1000 pixels each, on a Web Mercator map at zoom 11. Tile coordinates run from 0 to 2047. The client polls visible tiles about every 6 seconds.

The CDN caches a tile for 5 seconds (`s-maxage=5`). Each tile carries an `ETag` and `Last-Modified`, so a conditional request tells you whether it changed. Tile 2048 and above answer `404`, as does `s1`.

The map renderer fetches tiles outside the API client, so Pawtect never inspects them. [[Coordinates]] shows how to turn a latitude and longitude into a tile.

Counts toward the tile [[Rate-limits|rate limit]].

Related: [[Get-pixel]], [[Get-random-tile]].
