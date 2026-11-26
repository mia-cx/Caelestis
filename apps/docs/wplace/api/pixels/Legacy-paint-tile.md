---
title: Paint one tile (legacy)
description: The older per-tile paint request, before the client switched to one paint request.
tags:
  - source/community
  - pawtect/token
operation:
  protocol: rest
  method: POST
  path: /s{season}/pixel/{tileX}/{tileY}
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
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
  requestBody:
    schema:
      type: object
      properties:
        colors:
          type: array
          items:
            type: integer
        coords:
          type: array
          items:
            type: integer
    example:
      colors:
        - 5
      coords:
        - 381
        - 570
  responses:
    "200":
      description: Painted.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** This request requires an `x-pawtect-token` header, which the client builds for it; see [[Anti-cheat]]. The client reads the response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Best guess: not called by the client; seen in openplace's protocol notes and older userscripts. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The current client no longer paints this way; it sends [[Paint-pixels]]. The same path still answers lookups with `GET`, as [[Get-pixel]]. **Unverified:** whether the server still accepts this `POST`; it was not tried.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
