---
title: Player leaderboard entry
description: One player row on a player leaderboard, with pixel count and profile fields.
model:
  name: Player-leaderboard-entry
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 1000001
      name:
        type: string
        example: ExamplePlayer
      allianceId:
        type: integer
        example: 12345
      allianceName:
        type: string
        example: Example Alliance
      equippedFlag:
        type: integer
        example: 0
      pixelsPainted:
        type: integer
        example: 12000
      picture:
        type: string
        example: https://files.wplace.live/example.png
        description: Profile picture URL, when set.
      avatarSeed:
        type: string
        example: 00000000-0000-4000-8000-000000000000
      discord:
        type: string
        example: example_handle
      discordId:
        type: string
        example: "100000000000000000"
      frameUrl:
        type: string
        example: https://files.wplace.live/img/frames/example.png
      equippedNameCosmetic:
        $ref: Name-cosmetic
---

Returned by [[Get-player-leaderboard]] and [[Get-region-player-leaderboard]]. `discord` and `discordId` appear only when the player shows them.
