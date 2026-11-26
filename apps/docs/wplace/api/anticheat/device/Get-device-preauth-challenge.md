---
title: Get a pre-sign-in challenge
description: Get the challenge the iOS app signs before sign-in.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /device/preauth/challenge
  auth: none
  responses:
    "200":
      description: The challenge.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** not called live.

iOS app only.

Counts toward the API [[Rate-limits|rate limit]].
