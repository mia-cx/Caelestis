---
title: Record a store event
description: Analytics ping for store views and clicks.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: POST
  path: /store/events
  auth:
    scheme: optional session cookie
    description: Works without an account; a `j` cookie adds the player's own data.
  parameters:
    - name: j
      in: cookie
      required: false
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example: {}
  responses:
    "204":
      description: Recorded.
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].
