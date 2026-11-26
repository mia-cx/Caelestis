---
title: Rewind a tile (staff)
description: Staff-only route that shows a tile as it was at an earlier time.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: GET
  path: /staff/tools/wayback/s{season}/l{limit}/x{tileX}/y{tileY}/t{timestamp}
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
    - name: limit
      in: path
      required: true
      type: string
      example: <limit>
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
    - name: timestamp
      in: path
      required: true
      type: string
      example: <timestamp>
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: OK.
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

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live.

Shows a tile as it was at an earlier time.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
