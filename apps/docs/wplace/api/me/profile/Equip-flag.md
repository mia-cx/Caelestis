---
title: Equip a flag
description: Show one of the player's owned flags next to their name.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /flag/equip/{flagId}
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: flagId
      in: path
      required: true
      type: integer
      example: 0
      description: Flag id. `0` removes the flag.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: Equipped.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Purchase-item]], [[Error]].
