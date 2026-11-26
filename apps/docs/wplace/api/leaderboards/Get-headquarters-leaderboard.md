---
title: Get the headquarters leaderboard
description: Rank the members of the player's alliance by pixels painted on its headquarters.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliance/headquarters/leaderboard/{period}
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: period
      in: path
      required: true
      type: string
      example: today
      description: One of `today`, `week`, `month` or `all-time`.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: Members with headquarters pixel counts.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: Not allowed.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-own-headquarters]], [[Error]].
