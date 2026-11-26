---
title: Country leaderboard entry
description: "One country row on the country leaderboard: a country id and its pixel count."
model:
  name: Country-leaderboard-entry
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 75
      pixelsPainted:
        type: integer
        example: 3000000
---

Returned by [[Get-country-leaderboard]]. The client maps `id` to a country name and flag itself.
