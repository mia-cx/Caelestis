---
title: Headquarters
description: "An alliance headquarters: its anchor on the map, its canvas bounds and visibility."
model:
  name: Headquarters
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 105
      allianceId:
        type: integer
        example: 12345
      allianceName:
        type: string
        example: Example Alliance
      anchor:
        type: object
        properties:
          latitude:
            type: number
            example: 48.85
          longitude:
            type: number
            example: 2.35
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
---

Returned by [[Get-alliance-headquarters]]. A headquarters is a separate square canvas, anchored at a map coordinate. `eventHwm` grows with every paint on it, so the client uses it as an image version.
