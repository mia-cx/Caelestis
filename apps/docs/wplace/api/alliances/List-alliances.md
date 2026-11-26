---
title: List alliances
description: Browse and search the public alliance gallery, 20 alliances per page.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliances
  auth: none
  parameters:
    - name: sort
      in: query
      type: string
      example: pixels
      required: true
      description: "Sort order. Seen: `pixels`, `members`."
    - name: page
      in: query
      type: integer
      example: 0
      required: true
      description: Page, from 0.
    - name: q
      in: query
      type: string
      example: art
      description: Search by name.
    - name: joinPolicy
      in: query
      type: string
      example: open
      description: Only alliances with this join policy.
  responses:
    "200":
      description: One page of alliances.
      schema:
        $ref: Alliance-gallery-page
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance]], [[Alliance-gallery-page]].
