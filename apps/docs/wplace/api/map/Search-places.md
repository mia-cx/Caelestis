---
title: Search places
description: Autocomplete a place name to coordinates, as the map's search box does.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /v1/autocomplete
  server: https://geocoding.wplace.live
  auth: none
  parameters:
    - name: text
      in: query
      type: string
      example: Lyon
      required: true
      description: What the player typed.
  responses:
    "200":
      description: A Pelias GeoJSON feature collection.
      example:
        geocoding:
          version: "0.2"
        type: FeatureCollection
        features: []
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it.

Wplace runs its own Pelias geocoder. The response is standard Pelias: a `geocoding` header and GeoJSON `features`. The search box sends one request as the player types.

Not covered by the measured [[Rate-limits|rate limits]]; this host's limit is unmeasured.

Related: [[Get-map-style]].
