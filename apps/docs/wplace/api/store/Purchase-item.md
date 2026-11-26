---
title: Buy a colour or flag
description: Buy a premium colour, a flag or another droplet item.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /purchase
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
      product:
        id: 100
        amount: 1
        variant: 5
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
      description: No such item.
    "409":
      description: Already owned.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Seen product ids: `100` buys the colour whose palette index is `variant`, and `110` buys the flag whose id is `variant`. The iOS app sends `{ productId, appAccountToken }` instead.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-me]], [[Equip-flag]], [[Error]].
