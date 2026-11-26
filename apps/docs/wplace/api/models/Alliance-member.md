---
title: Alliance member
description: One member in an alliance's public member list, with their role.
model:
  name: Alliance-member
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 1000001
      name:
        type: string
        example: ExamplePlayer
      role:
        type: string
        example: member
      picture:
        type: string
        example: https://files.wplace.live/example.png
      avatarSeed:
        type: string
        example: 00000000-0000-4000-8000-000000000000
---

Items of [[Alliance-members-page]].
