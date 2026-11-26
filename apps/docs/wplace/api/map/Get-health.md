---
title: Check backend health
description: Check whether Wplace's backend is up.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /health
  auth: none
  responses:
    "200":
      description: The backend is up.
      schema:
        $ref: Health
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request confirmed the response.

The client calls this to tell "offline" from "server down" after a failed request.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Health]].
