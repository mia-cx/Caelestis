---
title: Record an onboarding event
description: Analytics ping for the onboarding experiment the visitor is in.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: POST
  path: /onboarding/experiment/events
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
      experiment: <experiment>
      visitorId: <visitor id>
      variant: <variant>
      event: <event>
      value: 1
  responses:
    "204":
      description: Recorded.
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it.

Counts toward the API [[Rate-limits|rate limit]].
