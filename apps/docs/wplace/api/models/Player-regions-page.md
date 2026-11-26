---
title: Player regions page
description: A page of regions in one country, for the region filter on the player leaderboard.
model:
  name: Player-regions-page
  schema:
    type: object
    properties:
      hasMore:
        type: boolean
        example: true
      regions:
        type: array
        items:
          type: object
          properties:
            id:
              type: integer
              example: 90000
            name:
              type: string
              example: Paris
            number:
              type: integer
              example: 5
            countryId:
              type: integer
              example: 75
---

Returned by [[Get-player-leaderboard-regions]].
