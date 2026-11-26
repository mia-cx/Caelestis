---
title: Painter
description: The player who last painted a pixel, as the pixel endpoint returns them.
model:
  name: Painter
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
        description: 0 when the player has no alliance.
      allianceName:
        type: string
        example: Example Alliance
      equippedFlag:
        type: integer
        example: 0
        description: Flag id, 0 for none.
      avatarSeed:
        type: string
        example: 00000000-0000-4000-8000-000000000000
        description: Seeds the generated avatar.
      discord:
        type: string
        example: example_handle
        description: Discord handle, when the player shows it.
      discordId:
        type: string
        example: "100000000000000000"
        description: Discord user id, when the player shows it.
      equippedFrameId:
        type: integer
        example: 4
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
        description: Three badge slots; `null` when empty.
      banned:
        type: boolean
        example: true
        description: Seen only on banned accounts.
    required:
      - id
      - name
      - allianceId
      - allianceName
      - equippedFlag
---

The `paintedBy` object of [[Get-pixel]]. Optional fields appear only when the player has set them. `banned` was seen on 20 November 2026 for a banned account; it was absent from the accounts checked on 26 November 2026.
