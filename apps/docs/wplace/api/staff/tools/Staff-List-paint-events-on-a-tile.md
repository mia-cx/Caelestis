---
title: List paint events on a tile (staff)
description: Staff-only route that pages through the paint events on one tile up to a given time, with painter ids and pixels.
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
      type: integer
      example: 1000
      description: Events per page, 1 to 10,000.
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
      type: integer
      example: 1795650000000
      description: Read events up to this time, in Unix milliseconds. No later than the server's clock.
    - name: cursorTs
      in: query
      type: integer
      example: 1795640000000
      description: Next-page cursor. Copy from the last event. The four cursor fields go together.
    - name: cursorUserId
      in: query
      type: integer
      example: 1
      description: Next-page cursor, the last event's `userId`.
    - name: cursorAllianceId
      in: query
      type: integer
      example: 0
      description: Next-page cursor, the last event's `allianceId`.
    - name: cursorPixelsCount
      in: query
      type: integer
      example: 12
      description: Next-page cursor, the last event's `pixelsCount`.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: "`{ events: [...], hasMore }`. Each event has `ts`, `userId`, `allianceId`, `pixelsCount`, `pixelsX`, `pixelsY` and `colors`."
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

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live. Read from the client's API module, chunk `BcgqpPa1.js`, and the dashboard's wayback page on 26 November 2026.

Lists the paint events on one tile up to `timestamp`. It returns events, not an image. The client method is `getWaybackEvents`, and the dashboard calls it "wayback". The dashboard loads the tile image separately, replays the events over it, and names the painters with [[Staff-Look-up-accounts-by-id]].

To read the next page, pass the last event's `ts`, `userId`, `allianceId` and `pixelsCount` as the four cursor parameters. The client refuses a request with only some of them.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Look-up-accounts-by-id]], [[Get-tile]], [[Error]].
