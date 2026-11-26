---
title: Get the store catalogue
description: List every product in the store, with prices and what each grants.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /store/catalog
  auth: none
  parameters:
    - name: platform
      in: query
      type: string
      example: web
      required: true
      description: The storefront.
  responses:
    "200":
      description: The catalogue.
      schema:
        $ref: Store-catalog
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request confirmed the response.

Cached for 30 seconds.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-store-offers]], [[Store-catalog]].
