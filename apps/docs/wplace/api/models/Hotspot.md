---
title: Hotspot
description: One of the busiest map regions right now, with a coordinate and pixel count.
model:
  name: Hotspot
  schema:
    type: object
    properties:
      regionId:
        type: integer
        example: 90000
      lat:
        type: number
        example: 48.85
      lng:
        type: number
        example: 2.35
      pixelsPainted:
        type: integer
        example: 5000
---

Returned by [[Get-hotspots]].
