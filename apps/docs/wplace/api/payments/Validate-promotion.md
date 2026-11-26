---
title: Check a coupon
description: Check whether a coupon code applies to a product before checkout.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /payment/promotions/validate
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
      couponCode: <coupon code>
      lookupKey: <product lookup key>
      provider: <payment provider>
  responses:
    "200":
      description: The discount.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Checkout sends `couponCode`, `lookupKey` and `provider`. The droplet store sends only `couponCode`, and reads `productIds` back to see which packs it applies to. The client reads `valid` and `supersededBySale`. **Unverified:** the other response fields.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
