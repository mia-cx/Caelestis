---
title: Get a pixel
description: Get the painter, alliance and region of one pixel, with no account.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /s{season}/pixel/{tileX}/{tileY}
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
    - name: x
      in: query
      type: integer
      example: 381
      description: Pixel column inside the tile, 0 to 999. Defaults to 0.
    - name: y
      in: query
      type: integer
      example: 570
      description: Pixel row inside the tile, 0 to 999. Defaults to 0.
  responses:
    "200":
      description: The last painter and the region.
      schema:
        $ref: Pixel-info
    "400":
      description: "`x` or `y` out of range, or an unknown season."
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

This is the request the client sends when a player clicks a pixel. It names the last account to paint that pixel. It carries no paint time.

Without `x` and `y`, the server answers for pixel (0, 0) of the tile. A season other than `s0` answers `400`.

The client always sends cookies, but the lookup works without them. [[Coordinates]] converts a latitude and longitude to the tile and pixel.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-tile]], [[Pixel-info]], [[Update-privacy]], [[Error]].
