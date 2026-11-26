---
title: Region
description: A named map region, such as a city district, used by pixels and region leaderboards.
model:
  name: Region
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 90000
      cityId:
        type: integer
        example: 900
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

Regions name an area of the map. `number` tells regions of the same city apart, as in "Paris #5".
