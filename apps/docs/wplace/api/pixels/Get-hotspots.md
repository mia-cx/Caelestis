---
title: Get painting hotspots
description: List the 10 regions with the most painting right now, with coordinates.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /map/hotspots
  auth: none
  responses:
    "200":
      description: Ten hotspots.
      schema:
        type: array
        items:
          $ref: Hotspot
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The client loads hotspots at start and refreshes them at most every 30 minutes. Players who turned on `hotspotsOptOut` in [[Update-privacy]] don't count toward it.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-region-player-leaderboard]], [[Hotspot]].
