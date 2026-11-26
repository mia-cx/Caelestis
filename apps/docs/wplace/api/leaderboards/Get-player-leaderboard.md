---
title: Get the player leaderboard
description: Get the top 50 players by pixels painted, worldwide or in one country.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /leaderboard/player/{period}
  auth: none
  parameters:
    - name: period
      in: path
      required: true
      type: string
      example: today
      description: One of `today`, `week`, `month` or `all-time`.
    - name: country
      in: query
      type: integer
      example: 75
      description: Limit to one country.
  responses:
    "200":
      description: Up to 50 players.
      schema:
        type: array
        items:
          $ref: Player-leaderboard-entry
    "400":
      description: Unknown period, or a `region` filter.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

Periods other than `today`, `week`, `month` and `all-time` answer `400`. The client also sends a `region` filter, but an anonymous request with one answered `400`. **Unverified:** what `region` needs.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-player-leaderboard-rank]], [[Get-player-leaderboard-regions]], [[Player-leaderboard-entry]], [[Error]].
