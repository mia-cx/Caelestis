---
title: Get my player rank
description: Get the signed-in player's own row and rank on the player leaderboard.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /leaderboard/player/{period}/me
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
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
      description: Rank within one country.
    - name: region
      in: query
      type: integer
      example: 90000
      description: Rank within one region.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: The player's rank.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request got `401`. **Unverified:** the signed-in response, read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-player-leaderboard]], [[Error]].
