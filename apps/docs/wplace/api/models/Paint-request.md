---
title: Paint request
description: "The body the client sends to paint pixels: colours grouped by season and tile."
model:
  name: Paint-request
  schema:
    type: object
    properties:
      season:
        type: integer
        example: 0
      tiles:
        type: array
        items:
          type: object
          properties:
            x:
              type: integer
              example: 1037
            y:
              type: integer
              example: 704
            pixels:
              type: object
              properties:
                x:
                  type: array
                  items:
                    type: integer
                y:
                  type: array
                  items:
                    type: integer
                colors:
                  type: array
                  items:
                    type: integer
---

Sent to [[Paint-pixels]]. Pixels are grouped per tile. `x`, `y` and `colors` are parallel arrays: entry *i* paints pixel (`x[i]`, `y[i]`) of that tile with palette index `colors[i]`.
