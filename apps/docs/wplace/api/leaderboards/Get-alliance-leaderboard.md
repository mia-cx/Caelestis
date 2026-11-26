---
title: Get the alliance leaderboard
description: Get the top 50 alliances by pixels painted.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /leaderboard/alliance/{period}
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
      description: Up to 50 alliances.
      schema:
        type: array
        items:
          $ref: Alliance-leaderboard-entry
    "400":
      description: Bad parameters.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The client then loads each alliance's picture with [[Get-alliance-picture]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-leaderboard-rank]], [[Alliance-leaderboard-entry]], [[Error]].
