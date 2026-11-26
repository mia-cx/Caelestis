---
title: Create an invite link
description: Create an alliance invite link with an expiry and an optional use limit.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /alliance/invites
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
      durationDays: 7
      maxUses: null
  responses:
    "200":
      description: The new invite.
    "400":
      description: "`max_invites`: too many active invites."
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

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
