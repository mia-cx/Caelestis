---
title: Get the country leaderboard
description: Get the top 50 countries by pixels painted.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /leaderboard/country/{period}
  auth: none
  parameters:
    - name: period
      in: path
      required: true
      type: string
      example: today
      description: One of `today`, `week`, `month` or `all-time`.
  responses:
    "200":
      description: Up to 50 countries.
      schema:
        type: array
        items:
          $ref: Country-leaderboard-entry
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The client sends cookies with this request; it works without them.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Country-leaderboard-entry]].
