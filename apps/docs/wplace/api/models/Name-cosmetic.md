---
title: Name cosmetic
description: The font and style a player has equipped on their display name.
model:
  name: Name-cosmetic
  schema:
    type: object
    properties:
      fontId:
        type: integer
        example: 3
      styleId:
        type: integer
        example: 7
      resolved:
        type: object
        properties:
          text:
            type: string
            example: ExamplePlayer
            description: The name as rendered.
---

Shown on pixel lookups and leaderboards for players who bought a name cosmetic.

Used by: [[List-my-name-cosmetics]].
