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
      description: Built over the request body, per community notes. See [[Anti-cheat]].
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

**Pawtect:** Community notes say older clients sent an `x-pawtect-token` header built over this body; see [[Anti-cheat]]. The current client never sends this request, so it builds no token for it and reads no response.

Not called by the current client. Known from openplace's protocol notes and older userscripts. Checked on 26 November 2026. **Unverified:** whether the server still accepts this `POST`, and what auth and Pawtect token it needs now; it was not tried.

The current client paints with [[Paint-pixels]] instead. The same path still answers lookups with `GET`, as [[Get-pixel]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
