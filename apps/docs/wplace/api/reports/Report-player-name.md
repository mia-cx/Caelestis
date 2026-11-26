---
title: Report a player's name
description: Report a player's display name as offensive.
tags:
  - source/bundle
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /report/user/name
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
  responses:
    "200":
      description: "`success`, or a `reason` such as `target_cooldown`."
      example:
        success: true
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

In the client bundle, never called by the player UI. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
