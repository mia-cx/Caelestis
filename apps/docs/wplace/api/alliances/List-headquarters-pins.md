---
title: List headquarters pins
description: List the alliance headquarters shown on the map inside a latitude and longitude box.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliances/headquarters/pins
  auth: none
  parameters:
    - name: minLat
      in: query
      type: number
      example: 48.8
      required: true
      description: South edge.
    - name: maxLat
      in: query
      type: number
      example: 48.9
      required: true
      description: North edge.
    - name: minLng
      in: query
      type: number
      example: 2.3
      required: true
      description: West edge.
    - name: maxLng
      in: query
      type: number
      example: 2.4
      required: true
      description: East edge.
  responses:
    "200":
      description: Pins inside the box.
      schema:
        type: array
        items:
          $ref: Headquarters-pin
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The client sends the visible map bounds, rounded to 5 decimals, as the player pans. A community archiver reports at most 200 pins per answer, with no paging.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-headquarters]], [[Headquarters-pin]].
