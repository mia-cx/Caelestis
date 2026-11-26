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

Returned by [[Get-pixel]]. See [[Painter-attribution]] for what this reveals.
