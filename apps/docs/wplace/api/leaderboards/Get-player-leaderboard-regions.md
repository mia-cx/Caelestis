---
title: List regions in a country
description: Search the regions of one country, 50 at a time, for a leaderboard filter.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /leaderboard/player-regions
  auth: none
  parameters:
    - name: country
      in: query
      type: integer
      example: 75
      required: true
      description: Country id.
    - name: search
      in: query
      type: string
      example: ""
      description: Filter by name. Empty lists all.
    - name: offset
      in: query
      type: integer
      example: 0
      description: Paging offset.
  responses:
    "200":
      description: One page of regions.
      schema:
        $ref: Player-regions-page
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request confirmed the response.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-player-leaderboard]], [[Player-regions-page]].
