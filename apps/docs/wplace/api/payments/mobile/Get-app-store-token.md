---
title: Get an App Store token
description: Get the token the iOS app attaches to App Store purchases.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /payment/appstore/account-token
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
      challenge: <challenge>
  responses:
    "200":
      description: The token.
      example:
        token: <token>
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The iOS app adds a device assertion to this request.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
