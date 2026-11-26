---
title: Get the base map style
description: Get the MapLibre style for the street map under the canvas.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /styles/liberty
  server: https://maps.wplace.live
  auth: none
  responses:
    "200":
      description: A MapLibre style document.
      example:
        version: 8
        sources: {}
        sprite: …
        glyphs: …
        layers: []
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it.

The base map is an OpenFreeMap "Liberty" style served from Wplace's own host. It points at the vector tiles in [[Get-map-tilejson]], fonts under `/fonts/{fontstack}/{range}.pbf`, sprites under `/sprites/`, and shaded relief under `/natural_earth/`. The recording on 26 November 2026 saw all of them load.

The map renderer fetches these outside the API client.

Not covered by the measured [[Rate-limits|rate limits]]; this host's limit is unmeasured.
