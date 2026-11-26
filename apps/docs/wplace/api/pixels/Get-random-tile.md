---
title: Get a random place
description: Get a random painted tile and pixel, for the Random place button.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /s{season}/tile/random
  auth: none
  parameters:
    - name: season
      in: path
      required: true
      type: integer
      example: 0
      description: Season. `0` is the current and only season.
  responses:
    "200":
      description: A tile and a pixel inside it.
      schema:
        $ref: Random-tile
    "400":
      description: Unknown season.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The client flies to the returned pixel. `s1` and `s2` answer `400`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-tile]], [[Random-tile]], [[Error]].
