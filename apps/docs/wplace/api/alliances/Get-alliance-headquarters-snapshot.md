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

List the tiles you already hold in `knownTiles`, and the answer carries only what changed. `GET` on this path answers `404`. Caelestis decodes this format; **unverified** beyond that: the binary layout is not documented here.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-headquarters-manifest]].
