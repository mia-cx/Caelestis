---
title: Headquarters pin
description: An alliance headquarters marker on the world map.
model:
  name: Headquarters-pin
  schema:
    type: object
    properties:
      allianceId:
        type: integer
        example: 12345
      allianceName:
        type: string
        example: Example Alliance
      avatarSeed:
        type: string
        example: 00000000-0000-4000-8000-000000000000
      pictureVersionId:
        type: integer
        example: 48
      latitude:
        type: number
        example: 48.85
      longitude:
        type: number
        example: 2.35
---

Returned by [[List-headquarters-pins]].
