---
title: Map, search and status
description: The base map, place search, client version and backend health endpoints.
order: 2
---

Requests for the street map under the canvas, place search, and checks for whether the site is up. Some of these live on other Wplace hosts.

- [[Get-map-style|Get the base map style]]: Get the MapLibre style for the street map under the canvas.
- [[Get-map-tilejson|Get the vector tile source]]: Get the TileJSON that lists the base map's OpenMapTiles vector layers.
- [[Search-places|Search places]]: Autocomplete a place name to coordinates, as the map's search box does.
- [[Get-app-version|Get the web app version]]: Check which wplace.live build is live, to notice a new client release.
- [[Get-health|Check backend health]]: Check whether Wplace's backend is up.
