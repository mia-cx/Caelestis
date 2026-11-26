---
title: Alliance awards page
description: One page of an alliance's awards, with how many it has earned.
model:
  name: Alliance-awards-page
  schema:
    type: object
    properties:
      data:
        type: array
        items:
          $ref: Alliance-award
      earned:
        type: integer
        example: 6
      total:
        type: integer
        example: 6
      hasNext:
        type: boolean
        example: false
---

Returned by [[List-alliance-awards]].
