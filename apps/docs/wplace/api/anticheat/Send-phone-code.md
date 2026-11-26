---
title: Send a phone code
description: Send a verification code by SMS, Telegram or WhatsApp for the heaviest challenge.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /anticheat/otp/send
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
      phone: "+10000000000"
  responses:
    "200":
      description: Sent.
    "400":
      description: Invalid number.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: Not allowed to verify.
    "409":
      description: Number already used.
    "429":
      description: Too many attempts.
    "451":
      description: Region not supported.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Like every anti-cheat request, this page describes the request only. Leave challenges to the player; see [[Anti-cheat]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
