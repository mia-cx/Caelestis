---
title: Alliance gallery page
description: One page of the public alliance gallery, 20 alliances at a time.
model:
  name: Alliance-gallery-page
  schema:
    type: object
    properties:
      data:
        type: array
        items:
          $ref: Alliance-summary
      hasNext:
        type: boolean
        example: true
---

Returned by [[List-alliances]].
