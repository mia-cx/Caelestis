---
title: Get my headquarters canvas
description: Get the tile manifest of the player's own headquarters, including private ones.
tags:
  - source/bundle
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliance/headquarters/canvas
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
      description: Viewport left.
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

In the client bundle, never called by the player UI. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The client's API module still builds this request, with the same query as [[Get-own-headquarters-manifest]], but the headquarters editor calls that route instead. **Unverified:** whether the server still answers this one.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
