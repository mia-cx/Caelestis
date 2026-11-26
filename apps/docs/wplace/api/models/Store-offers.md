---
title: Store offers
description: Current store promotions and per-provider prices, keyed by product id.
model:
  name: Store-offers
  schema:
    type: object
    properties:
      revision:
        type: string
        example: r1
      generatedAt:
        type: string
        format: date-time
        example: 2026-11-26T12:00:00Z
      promotionsEnabled:
        type: boolean
        example: true
      couponEntry:
        type: boolean
        example: true
      products:
        type: object
        additionalProperties:
          type: object
          properties:
            promotion:
              type: object
            prices:
              type: object
---

Returned by [[Get-store-offers]]. Only the top-level fields are listed.
