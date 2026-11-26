---
title: Get the region leaderboard
description: Get the top 50 regions by pixels painted, worldwide or in one country.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /leaderboard/region/{period}/{countryId}
  auth: none
  parameters:
    - name: period
      in: path
      required: true
      type: string
      example: today
      description: One of `today`, `week`, `month` or `all-time`.
    - name: countryId
      in: path
      required: true
      type: integer
      example: 75
      description: Country id. `0` means every country.
  responses:
    "200":
      description: Up to 50 regions.
      schema:
        type: array
        items:
          $ref: Region-leaderboard-entry
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-region-player-leaderboard]], [[Get-region-alliance-leaderboard]], [[Region-leaderboard-entry]].
