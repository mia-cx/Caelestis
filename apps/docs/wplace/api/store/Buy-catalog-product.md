---
title: Buy a product with droplets
description: Buy a store product with droplets at the price the player saw.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /store/catalog/{productId}/buy
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: productId
      in: path
      required: true
      type: string
      example: <productId>
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      expectedPrice: 500
  responses:
    "200":
      description: The price paid and what it granted.
      example:
        price: 500
        grants: []
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

A changed price makes the server refuse the purchase.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
