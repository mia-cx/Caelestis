---
title: Get my suspension
description: Get the bans and timeouts active on the signed-in player's account.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /me/suspension
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
  responses:
    "200":
      description: "`active`, and `punishments` with `kind` (`ban` or `timeout`), `reason` and `timeoutUntil`."
      example:
        active: true
        punishments: [{ kind: timeout, reason: "<reason>", timeoutUntil: "2026-11-27T12:00:00Z" }]
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
