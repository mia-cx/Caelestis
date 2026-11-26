---
title: Buy a frame
description: Buy a profile frame with droplets.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /store/frames/buy/{frameId}
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: frameId
      in: path
      required: true
      type: string
      example: <frameId>
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: Bought.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: Not enough droplets.
    "404":
      description: No such frame.
    "409":
      description: Already owned.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
