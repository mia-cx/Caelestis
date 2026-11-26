---
title: MapUrlState
description: The query parameters wplace.live reads on load, such as lat, lng, zoom and season, and how to link a player to a place on the map.
tags: [source/caelestis, pawtect/none]
symbol:
  kind: interface
  name: MapUrlState
  signature: "https://wplace.live/?lat={lat}&lng={lng}&zoom={zoom}"
  members:
    - { name: lat, kind: property, signature: "lat: number", description: "Latitude of the camera centre. Ignored unless `lng` is also valid." }
    - { name: lng, kind: property, signature: "lng: number", description: "Longitude of the camera centre." }
    - { name: zoom, kind: property, signature: "zoom?: number", description: "MapLibre zoom." }
    - { name: season, kind: property, signature: "season?: number", description: "Season index. An integer from 0 to the last season." }
    - { name: select, kind: property, signature: "select?: boolean", description: "Select the pixel at the position. Best guess from the client code." }
    - { name: opaque, kind: property, signature: "opaque?: boolean", description: "Defaults to true. Best guess: draws the pixel art without transparency." }
    - { name: area, kind: property, signature: "area?: 'south,west,north,east'", description: "A bounding box, four numbers separated by commas." }
  source: https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/templates/navigate.ts
---

**Pawtect:** none. The URL is read once on load. Nothing in it reaches a token.

Wplace reads the camera from the query string when the page loads. It is the one hook that needs no script in the page: any link, bookmark or extension popup can use it.

```text
https://wplace.live/?lat=52.52&lng=13.40&zoom=14
```

Confirmed on 26 November 2026: that URL opens centred on 52.52° N, 13.40° E at zoom 14.

## Writing the URL

Wplace does not keep the URL in step with the camera. After `map.jumpTo` moved the map on the live client, `location.href` still showed the load position. So:

- To read where the player is looking, ask the [map](Map), not the URL.
- To move the camera without the map, set `location.href` to a new URL. That reloads the page. Caelestis does this when it cannot reach the map ([`templates/navigate.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/templates/navigate.ts)).

## Other routes

The app is a SvelteKit site. Game routes include `/join`, `/wayback`, `/tickets`, `/support` and `/appeals`. Settings tabs are reachable as `/settings/{tab}` (unverified as a deep link). Public pages include `/how-to-play`, `/guides/overlays`, `/guides/alliances`, `/about` and `/patch-notes`. On game routes, `<html>` carries `data-game-ui` ([DOM landmarks](DOM-landmarks)).

Other parameters, such as `error`, `domain` and `twitch-migration`, belong to sign-in and account flows.

## Related

- [Finding the map](Finding-the-map)
- [Coordinates](Coordinates) converts coordinates to tiles and pixels
