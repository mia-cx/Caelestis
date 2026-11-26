---
title: Time out a member
description: Bar a member from painting the headquarters for a while, with a reason.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /alliance/headquarters/timeouts
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
      userId: 1000001
      duration: 1h
      reason: Griefing
  responses:
    "200":
      description: Timed out.
    "400":
      description: "`headquarters_timeout_active` or `invalid_timeout_reason`."
      schema:
        $ref: Error
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: The player's role may not do this.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

`duration` is one of the strings the client offers: `1h`, `24h`, `7d` or `indefinite`. `reason` is free text of up to 500 characters. **Unverified:** whether the server accepts other durations.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
