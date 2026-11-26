---
title: Inspect an area (staff)
description: Staff-only route that returns the painter id and colour of every pixel in a rectangle of one tile, as binary.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: GET
  path: /staff/tools/select-area/s{season}/{tileX}/{tileY}
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
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
    - name: x0
      in: query
      required: true
      type: integer
      example: 100
      description: Left edge of the rectangle, in tile pixels.
    - name: y0
      in: query
      required: true
      type: integer
      example: 100
      description: Top edge of the rectangle, in tile pixels.
    - name: x1
      in: query
      required: true
      type: integer
      example: 140
      description: Right edge of the rectangle, in tile pixels.
    - name: y1
      in: query
      required: true
      type: integer
      example: 140
      description: Bottom edge of the rectangle, in tile pixels.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: Five bytes per pixel. A little-endian `uint32` painter id, then a `uint8` colour index.
      contentType: application/octet-stream
    "401":
      description: No session.
      schema:
        $ref: Error
    "403":
      description: The account is not staff.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live. Read from the client's API module, chunk `BcgqpPa1.js`, on 26 November 2026.

Returns who painted each pixel in a rectangle of one tile, and with which colour. The client method is `getPixelAreaInfo`. It reads the body as 5-byte records and splits them into a `paintedBy` array of ids and a `colors` array.

The body carries ids only. The staff area tool resolves them to names with [[Staff-Look-up-accounts-by-id]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Look-up-accounts-by-id]], [[Get-pixel]], [[Error]].
