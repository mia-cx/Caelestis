---
title: Random tile
description: A tile and pixel the client jumps to when a player asks for a random place.
model:
  name: Random-tile
  schema:
    type: object
    properties:
      tile:
        type: object
        properties:
          x:
            type: integer
            example: 1037
          y:
            type: integer
            example: 704
      pixel:
        type: object
        properties:
          x:
            type: integer
            example: 381
          y:
            type: integer
            example: 570
---

Returned by [[Get-random-tile]].
