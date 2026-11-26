---
title: Get a headquarters snapshot
description: Download the changed tiles of a headquarters area in one binary response.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /alliances/{allianceId}/headquarters/snapshot
  auth: none
  parameters:
    - name: allianceId
      in: path
      required: true
      type: integer
      example: 12345
      description: Alliance id.
  requestBody:
    schema:
      type: object
      properties:
        minX:
          type: integer
        minY:
          type: integer
        maxX:
          type: integer
        maxY:
          type: integer
        knownTiles:
          type: array
          items:
            type: object
            properties:
              x:
                type: integer
              y:
                type: integer
              version:
                type: integer
    example:
      minX: -100
      minY: -100
      maxX: 99
      maxY: 99
      knownTiles:
        - x: 0
          y: 0
          version: 12
  responses:
    "200":
      description: Changed and removed tiles, as `application/x-wplace-alliance-hq-snapshot`.
      contentType: application/x-wplace-alliance-hq-snapshot
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** not called live.

List the tiles you already hold in `knownTiles`, and the answer carries only what changed. `GET` on this path answers `404`. The signed-in editor posts the same body to `/alliance/headquarters/snapshot` with credentials; this public form sends none (rechecked in the API module, chunk `BcgqpPa1.js`, on 26 November 2026).

The answer is little-endian binary. Layout from Caelestis's research on 30 August 2026, not rechecked:

```text
5 bytes  magic "WHQS1"
u16      tile size (64)
i64      event high-water mark
u16      changed tile count
u16      removed tile count
per changed tile: i16 x, i16 y, i64 version, tileSize × tileSize palette indices (u8)
per removed tile: i16 x, i16 y
```

Tile coordinates are signed, like the headquarters' own. A full request for a 250 × 250 headquarters returned three tiles in 12,343 bytes. Repeated with those versions in `knownTiles`, it returned the 19-byte header alone. [[Alliance-editors|Alliance editors]] covers how the editor uses it.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-headquarters-manifest]], [[Alliance-editors]].
