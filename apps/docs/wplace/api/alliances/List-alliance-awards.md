---
title: List an alliance's awards
description: List an alliance's awards with tier, progress and thresholds.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliances/{allianceId}/awards
  auth: none
  parameters:
    - name: allianceId
      in: path
      required: true
      type: integer
      example: 12345
      description: Alliance id.
    - name: page
      in: query
      type: integer
      example: 0
      description: Page, from 0.
  responses:
    "200":
      description: One page of awards.
      schema:
        $ref: Alliance-awards-page
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance]], [[Set-featured-awards]], [[Alliance-awards-page]].
