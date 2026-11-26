---
title: Clear an area (staff)
description: Staff-only route that erases the pixels staff selected, sent as one paint-style request per tile with a Pawtect token.
tags:
  - source/bundle
  - pawtect/token
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/tools/select-area/clear/s{season}/pixel/{tileX}/{tileY}
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
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
    - name: x-pawtect-token
      in: header
      required: true
      type: string
      example: <pawtect-token>
      description: Built by the client for this exact request body. See [[Anti-cheat]].
  responses:
    "200":
      description: OK.
    "401":
      description: No session.
      schema:
        $ref: Error
    "403":
      description: The account is not staff, or a paint-style refusal such as `timeout` or `refresh`.
      schema:
        $ref: Error
---

**Pawtect:** This request carries an `x-pawtect-token` header, built for its body like a paint's ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live. Read from the client's API module, chunk `BcgqpPa1.js`, on 26 November 2026.

Erases the pixels staff selected. It is not one request per area. The client method `selectAreaClear` groups the selected pixels by tile and sends one request per tile, through the same code that sends [[Legacy-paint-tile|per-tile paints]]. Each body is JSON with `colors`, `coords` and `csid`, as in that legacy paint request.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Inspect-an-area]], [[Legacy-paint-tile]], [[Error]].
