---
title: Record a visit
description: Analytics ping the client sends on each page load, with a visitor id.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: POST
  path: /visits
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
    example:
      visitorId: <visitor id>
      platform: web
  responses:
    "204":
      description: Recorded.
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it.

Sent with `keepalive`, outside the API client, and never read.

Counts toward the API [[Rate-limits|rate limit]].
