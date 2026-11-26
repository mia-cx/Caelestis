---
title: Store catalog
description: "The store's product list: droplet packs, bundles and their prices."
model:
  name: Store-catalog
  schema:
    type: object
    properties:
      products:
        type: array
        items:
          type: object
          properties:
            id:
              type: integer
              example: 1
            lookupKey:
              type: string
              example: droplets_small
            placement:
              type: string
              example: main
            names:
              type: object
              properties:
                en:
                  type: string
                  example: Droplet pack
            descriptions:
              type: object
              properties:
                en:
                  type: string
                  example: A pack of droplets.
            imageUrl:
              type: string
              example: https://files.wplace.live/example.png
            priceCurrency:
              type: string
              example: usd
            price:
              type: integer
              example: 499
            totalValue:
              type: integer
              example: 499
            sortOrder:
              type: integer
              example: 1
            availableFrom:
              type: string
              format: date-time
              example: 2026-11-26T12:00:00Z
            availableUntil:
              type: string
              format: date-time
              example: 2026-11-26T12:00:00Z
            publishedAt:
              type: string
              format: date-time
              example: 2026-11-26T12:00:00Z
            perUserLimit:
              type:
                - integer
                - "null"
              example: null
            providers:
              type: array
              items:
                type: string
            items:
              type: array
              items:
                type: object
                properties:
                  kind:
                    type: string
                    example: droplets
                  ref:
                    type: integer
                    example: 0
                  amount:
                    type: integer
                    example: 1000
                  value:
                    type: integer
                    example: 499
      hidden:
        type: array
        items:
          type: integer
---

Returned by [[Get-store-catalog]]. Only the top-level fields are listed; each product's `items` describe what it grants.
