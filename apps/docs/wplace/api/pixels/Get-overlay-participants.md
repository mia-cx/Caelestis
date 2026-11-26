---
title: Get overlay participants
description: Upload a gzipped template mask and learn which players painted inside it.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /s{season}/overlay/participants
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
    - name: x
      in: query
      type: integer
      example: 1037000
      required: true
      description: Left edge of the area, in world pixels.
    - name: y
      in: query
      type: integer
      example: 704000
      required: true
      description: Top edge of the area, in world pixels.
    - name: width
      in: query
      type: integer
      example: 200
      required: true
      description: Area width in pixels.
    - name: height
      in: query
      type: integer
      example: 200
      required: true
      description: Area height in pixels.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    contentType: application/octet-stream
    example: <gzipped template mask>
  responses:
    "200":
      description: Players who painted inside the template.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "413":
      description: The area is too large.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The client sends this from the overlay panel, for one of the player's own templates. The body is a gzip-compressed mask built from the template image. **Unverified:** the mask encoding and the response fields; the client caches an answer for 60 seconds.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-pixel]], [[Painter-attribution]], [[Error]].
