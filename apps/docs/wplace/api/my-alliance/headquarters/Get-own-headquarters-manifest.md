---
title: Get my headquarters tile manifest
description: List the tiles of the player's own alliance headquarters canvas with their versions, including a private headquarters.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliance/headquarters/manifest
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: metadataOnly
      in: query
      type: boolean
      example: true
      description: Leave out the tile list.
    - name: minX
      in: query
      type: integer
      example: -100
      description: Viewport left, in canvas pixels.
    - name: minY
      in: query
      type: integer
      example: -100
      description: Viewport top.
    - name: maxX
      in: query
      type: integer
      example: 100
      description: Viewport right.
    - name: maxY
      in: query
      type: integer
      example: 100
      description: Viewport bottom.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: The manifest.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The member version of [[Get-alliance-headquarters-manifest]]: the headquarters editor builds the same query and sends the session cookie. **Unverified:** that the response matches [[Headquarters-manifest]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-own-headquarters-snapshot]], [[Error]].
