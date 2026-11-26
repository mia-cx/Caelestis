---
title: Get an alliance's headquarters
description: Get where an alliance's headquarters sits on the map, its size and canvas version.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliances/{allianceId}/headquarters
  auth: none
  parameters:
    - name: allianceId
      in: path
      required: true
      type: integer
      example: 12345
      description: Alliance id.
  responses:
    "200":
      description: The headquarters.
      schema:
        $ref: Headquarters
    "404":
      description: No visible headquarters.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The response is not cached (`no-store`). Use `eventHwm` as the version for [[Get-alliance-headquarters-image]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-headquarters-manifest]], [[List-headquarters-pins]], [[Headquarters]], [[Error]].
