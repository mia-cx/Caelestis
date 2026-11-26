---
title: Record client telemetry
description: Client telemetry event, refused with 401 for anonymous visitors.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /frontend/telemetry
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
      event: <event>
      data: {}
  responses:
    "200":
      description: Recorded.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it. **Unverified:** the signed-in response, read from the client code, since the guide makes no signed-in requests.

The recording saw anonymous requests answered with `401`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
