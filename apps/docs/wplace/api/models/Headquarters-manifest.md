---
title: Headquarters manifest
description: The list of a headquarters canvas's tiles, each with a URL and version.
model:
  name: Headquarters-manifest
  schema:
    type: object
    properties:
      headquartersId:
        type: integer
        example: 105
      bounds:
        type: object
        properties:
          minX:
            type: integer
            example: -1000
          minY:
            type: integer
            example: -1000
          maxX:
            type: integer
            example: 999
          maxY:
            type: integer
            example: 999
      eventHwm:
        type: integer
        example: 575802
      size:
        type: integer
        example: 2000
      tileSize:
        type: integer
        example: 64
        description: Unverified example value.
      visibility:
        type: string
        example: public
      tiles:
        type: array
        items:
          type: object
          properties:
            x:
              type: integer
              example: 0
            y:
              type: integer
              example: 0
            version:
              type: integer
              example: 12
            url:
              type: string
              example: <tile URL>
---

Returned by [[Get-alliance-headquarters-manifest]]. A client fetches only the tiles whose `version` changed.
