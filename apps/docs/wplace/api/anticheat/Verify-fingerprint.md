---
title: Submit a device check
description: Send a Fingerprint Pro sealed result after a `verification-required` refusal.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /anticheat/verify
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
    example: {}
  responses:
    "200":
      description: Accepted.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Like every anti-cheat request, this page describes the request only. Leave challenges to the player; see [[Anti-cheat]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
