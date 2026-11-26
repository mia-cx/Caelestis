---
title: Pre-authorise a device
description: Exchange a signed challenge for the ticket the iOS app sends with sign-in.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /device/preauth
  auth: none
  requestBody:
    example: {}
  responses:
    "200":
      description: The ticket.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** not called live.

iOS app only.

Counts toward the API [[Rate-limits|rate limit]].
