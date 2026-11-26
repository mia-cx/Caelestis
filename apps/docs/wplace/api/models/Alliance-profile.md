---
title: Alliance profile
description: "An alliance's public profile: name, description, members, awards and headquarters."
model:
  name: Alliance-profile
  schema:
    type: object
    properties:
      id:
        type: integer
        example: 12345
      name:
        type: string
        example: Example Alliance
      avatarSeed:
        type: string
        example: 00000000-0000-4000-8000-000000000000
      awardCount:
        type: integer
        example: 6
      bannerVersionId:
        type: integer
        example: 140
      pictureVersionId:
        type: integer
        example: 48
      createdAt:
        type: string
        format: date-time
        example: 2026-11-26T12:00:00Z
      lastActivityAt:
        type: string
        format: date-time
        example: 2026-11-26T12:00:00Z
      description:
        type: string
        example: "# Welcome"
      descriptionMode:
        type: string
        example: markdown
      descriptionPreview:
        type: string
        example: Welcome
      discordInvite:
        type: string
        example: https://discord.gg/example
      featuredAwards:
        type: array
        items:
          $ref: Featured-award
      headquarters:
        type: object
        properties:
          id:
            type: integer
            example: 105
          latitude:
            type: number
            example: 48.85
          longitude:
            type: number
            example: 2.35
          size:
            type: integer
            example: 2000
      hidePictureOutline:
        type: boolean
        example: false
      joinPolicy:
        type: string
        example: invite_only
        description: "Seen values: `invite_only`. The gallery filter also sends `open`."
      members:
        type: integer
        example: 120
      pixelsPainted:
        type: integer
        example: 250000
---

Returned by [[Get-alliance]]. `headquarters` is present only when the alliance has one.
