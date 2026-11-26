---
title: Alliance leaderboard entry
description: One alliance row on an alliance leaderboard, with its pixel count.
model:
  name: Alliance-leaderboard-entry
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 12345
      name:
        type: string
        example: Example Alliance
      pixelsPainted:
        type: integer
        example: 250000
      avatarSeed:
        type: string
        example: 00000000-0000-4000-8000-000000000000
      pictureVersionId:
        type: integer
        example: 48
---

Returned by [[Get-alliance-leaderboard]] and [[Get-region-alliance-leaderboard]].
