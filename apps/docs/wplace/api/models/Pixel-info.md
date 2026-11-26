---
title: Pixel info
description: The painter and region of one pixel, as returned by the pixel lookup.
model:
  name: Pixel-info
  schema:
    type: object
    properties:
      paintedBy:
        $ref: Painter
      region:
        $ref: Region
---

Returned by [[Get-pixel]]. [[Update-privacy]] lists which painter fields a player can hide.
