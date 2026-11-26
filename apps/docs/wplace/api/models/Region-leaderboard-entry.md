---
title: Region leaderboard entry
description: One region row on the region leaderboard, with pixel count and last painted spot.
model:
  name: Region-leaderboard-entry
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 90000
      name:
        type: string
        example: Paris
      cityId:
        type: integer
        example: 900
      number:
        type: integer
        example: 5
      countryId:
        type: integer
        example: 75
      pixelsPainted:
        type: integer
        example: 80000
      lastLatitude:
        type: number
        example: 48.85
      lastLongitude:
        type: number
        example: 2.35
---

Returned by [[Get-region-leaderboard]]. `lastLatitude` and `lastLongitude` point at the region's most recent paint.
