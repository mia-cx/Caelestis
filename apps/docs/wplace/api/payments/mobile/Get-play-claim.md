---
title: Get a Play claim
description: Check whether one Google Play purchase was credited.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /payment/play/claim/{token}
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: token
      in: path
      required: true
      type: string
      example: <token>
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: The claim.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "404":
      description: Unknown.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
