---
title: Pixels and tiles
description: "Read the canvas: tiles, single pixels, hotspots and the paint request."
order: 1
---

The canvas, one tile or pixel at a time. [[Painter-attribution]] shows how these combine.

- [[Get-pixel|Get a pixel]]: Get the painter, alliance and region of one pixel, with no account.
- [[Get-tile|Get a map tile]]: Download one 1000 × 1000 canvas tile as a PNG, cached for 5 seconds.
- [[Get-random-tile|Get a random place]]: Get a random painted tile and pixel, for the Random place button.
- [[Get-hotspots|Get painting hotspots]]: List the 10 regions with the most painting right now, with coordinates.
- [[Get-overlay-participants|Get overlay participants]]: Upload a gzipped template mask and learn which players painted inside it.
- [[Paint-pixels|Paint pixels]]: The request the client sends when a player presses Paint, with its Pawtect token.
- [[Legacy-paint-tile|Paint one tile (legacy)]]: The older per-tile paint request, before the client switched to one paint request.
