---
title: Me
description: "The signed-in player's account: charges, droplets, owned colours and profile."
model:
  name: Me
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 1000001
      name:
        type: string
        example: ExamplePlayer
      level:
        type: number
        example: 12.5
      pixelsPainted:
        type: integer
        example: 12000
      droplets:
        type: integer
        example: 500
      charges:
        type: object
        properties:
          count:
            type: number
            example: 12.4
          max:
            type: integer
            example: 30
          cooldownMs:
            type: integer
            example: 30000
      extraColorsBitmap:
        type: integer
        example: 0
      flagsBitmap:
        type: string
        example: <bitmap>
        description: Owned flags. Encoding unverified.
      equippedFlag:
        type: integer
        example: 0
      equippedFrameUrl:
        type: string
        example: https://files.wplace.live/img/frames/example.png
      equippedNameCosmetic:
        $ref: Name-cosmetic
      equippedBadges:
        type: array
        items:
          type:
            - integer
            - "null"
      discord:
        type: string
        example: example_handle
      discordId:
        type: string
        example: "100000000000000000"
      picture:
        type: string
        example: https://files.wplace.live/example.png
      avatarSeed:
        type: string
        example: 00000000-0000-4000-8000-000000000000
      maxFavoriteLocations:
        type: integer
        example: 15
        description: Pawtect flags a value of `Infinity`; see [[Anti-cheat]].
      role:
        type: string
        example: user
        description: Account role. Values other than a player role unverified.
---

Returned by [[Get-me]]. **Unverified:** these fields come from the client code and Caelestis, not from a live response, because the guide makes no signed-in requests. The list is partial.

`charges.count` is fractional and grows by one every `charges.cooldownMs`. `extraColorsBitmap` is a bit mask over the premium colours in palette order: bit 0 is the first premium colour, not palette index 0.
