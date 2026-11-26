---
title: Get my headquarters snapshot
description: Download the changed tiles of an area of the player's own alliance headquarters in one binary response.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /alliance/headquarters/snapshot
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
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
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The member version of [[Get-alliance-headquarters-snapshot]]. The headquarters editor posts the same body with the session cookie, and reads the same binary layout.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-own-headquarters-manifest]], [[Alliance-editors]], [[Error]].
