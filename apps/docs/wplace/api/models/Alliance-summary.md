---
title: Alliance summary
description: The short alliance card shown in the alliance gallery.
model:
  name: Alliance-summary
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
      descriptionPreview:
        type: string
        example: A short plain-text preview.
      pixelsPainted:
        type: integer
        example: 250000
      members:
        type: integer
        example: 120
      createdAt:
        type: string
        format: date-time
        example: 2026-11-26T12:00:00Z
      awardCount:
        type: integer
        example: 6
      featuredAwards:
        type: array
        items:
          $ref: Featured-award
      pictureVersionId:
        type: integer
        example: 48
      bannerVersionId:
        type: integer
        example: 140
      hidePictureOutline:
        type: boolean
        example: false
---

Items of [[Alliance-gallery-page]].
