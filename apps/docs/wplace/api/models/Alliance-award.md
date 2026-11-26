---
title: Alliance award
description: One alliance award with its current tier, progress and tier thresholds.
model:
  name: Alliance-award
  schema:
    type: object
    properties:
      key:
        type: string
        example: pixels
      currentTier:
        type: string
        example: epic
      nextTier:
        type: string
        example: legendary
      earnedAt:
        type: string
        format: date-time
        example: 2026-11-26T12:00:00Z
      featured:
        type: boolean
        example: true
      position:
        type: integer
        example: 1
      progress:
        type: object
        properties:
          current:
            type: integer
            example: 250000
          target:
            type: integer
            example: 500000
      tiers:
        type: array
        items:
          type: object
          properties:
            tier:
              type: string
              example: common
            criteriaVersion:
              type: integer
              example: 1
            threshold:
              type: integer
              example: 1000
            earnedAt:
              type: string
              format: date-time
              example: 2026-11-26T12:00:00Z
---

Items of [[Alliance-awards-page]].
