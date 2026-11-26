---
title: Get a region's top players
description: Get the top 50 players who painted in one region.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /leaderboard/region/players/{regionId}/{period}
  auth: none
  parameters:
    - name: regionId
      in: path
      required: true
      type: integer
      example: 90000
      description: Region id, from a pixel lookup or a region leaderboard.
    - name: period
      in: path
      required: true
      type: string
      example: today
      description: One of `today`, `week`, `month` or `all-time`.
  responses:
    "200":
      description: Up to 50 players.
      schema:
        type: array
        items:
          $ref: Player-leaderboard-entry
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request confirmed the response.

Note the order: region first, then period. Each [[Get-hotspots|hotspot]] carries the `regionId` this takes.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-region-leaderboard]], [[Player-leaderboard-entry]].
