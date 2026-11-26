---
title: Paint pixels
description: The request the client sends when a player presses Paint, with its Pawtect token.
tags:
  - source/client
  - pawtect/token
operation:
  protocol: rest
  method: POST
  path: /paint
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
    - name: x-pawtect-token
      in: header
      required: true
      type: string
      example: <pawtect-token>
      description: Built by the client for this exact request body. See [[Anti-cheat]].
  requestBody:
    schema:
      $ref: Paint-request
    example:
      season: 0
      tiles:
        - x: 1037
          y: 704
          pixels:
            x:
              - 381
              - 382
            y:
              - 570
              - 570
            colors:
              - 5
              - 5
  responses:
    "200":
      description: Painted.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: "Refused: `timeout` (with `durationMs`), `refresh`, `color-not-owned`, `company-paint-outside-allowed-area`, `event-pixel-present` (an event pixel is in the way), not enough `charges`, `challenge-required`, or a Cloudflare challenge."
      schema:
        $ref: Error
---

**Pawtect:** This request requires an `x-pawtect-token` header, which the client builds for it; see [[Anti-cheat]]. The client reads the response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

This page documents what the client sends. Wplace's rules ban painting through anything but the site's own controls, so a mod must not send this request itself.

One request carries every pixel of one paint, grouped by tile. The iOS app adds an Apple device assertion to it.

A `403` with `challenge-required` and a `tier` makes the client run a challenge and retry; see [[Anti-cheat]]. Older clients painted one tile per request with [[Legacy-paint-tile]].

Counts toward the API [[Rate-limits|rate limit]].

The `200` body's `painted` is a count. When it is lower than the number of pixels sent, the response doesn't say which ones failed ([[Reading-the-paint-UI|Reading the paint UI]]).

Related: [[Get-me]], [[Purchase-item]], [[Paint-request]], [[Palette]], [[Error]].
