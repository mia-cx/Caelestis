---
title: Get my alliance's member leaderboard
description: Rank the members of the player's own alliance by pixels, with last pixel locations.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliance/leaderboard/{period}
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
      description: Members with pixel counts.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: The player's role may not see it.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request got `401`. **Unverified:** the signed-in response, read from the client code, since the guide makes no signed-in requests.

Entries include each member's last painted pixel unless they turned `showLastPixel` off in [[Update-privacy]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Painter-attribution]], [[Error]].
