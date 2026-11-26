---
title: Get a headquarters tile manifest
description: List the tiles of an alliance's headquarters canvas with their versions.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliances/{allianceId}/headquarters/manifest
  auth: none
  parameters:
    - name: allianceId
      in: path
      required: true
      type: integer
      example: 12345
      description: Alliance id.
    - name: metadataOnly
      in: query
      type: boolean
      example: true
      description: Leave out the tile list.
    - name: minX
      in: query
      type: integer
      example: -100
      description: Viewport left, in canvas pixels.
    - name: minY
      in: query
      type: integer
      example: -100
      description: Viewport top.
    - name: maxX
      in: query
      type: integer
      example: 100
      description: Viewport right.
    - name: maxY
      in: query
      type: integer
      example: 100
      description: Viewport bottom.
  responses:
    "200":
      description: The manifest.
      schema:
        $ref: Headquarters-manifest
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request confirmed the response.

Without a viewport, the list covers the whole canvas: over 1000 tiles for a 2000 × 2000 headquarters. Fetch only tiles whose `version` changed.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-headquarters-snapshot]], [[Get-alliance-headquarters]], [[Headquarters-manifest]].
