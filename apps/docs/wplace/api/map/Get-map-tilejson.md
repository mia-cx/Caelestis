---
title: Get the vector tile source
description: Get the TileJSON that lists the base map's OpenMapTiles vector layers.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /planet
  server: https://maps.wplace.live
  auth: none
  responses:
    "200":
      description: A TileJSON document.
      example:
        tilejson: 3.0.0
        tiles:
          - …
        vector_layers: []
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it.

The vector tiles follow the OpenMapTiles schema. A mod that draws its own base map can reuse this source.

Not covered by the measured [[Rate-limits|rate limits]]; this host's limit is unmeasured.

Related: [[Get-map-style]].
