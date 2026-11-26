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
            type: number
            example: 381.42
          y:
            type: number
            example: 570.18
---

Returned by [[Get-random-tile]]. `pixel.x` and `pixel.y` often have a fractional part. Checked on 26 November 2026 with anonymous requests.
