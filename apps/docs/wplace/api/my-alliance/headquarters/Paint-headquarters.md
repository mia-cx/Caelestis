---
title: Paint the headquarters
description: The request the client sends to paint pixels on the alliance headquarters canvas.
tags:
  - source/client
  - pawtect/token
operation:
  protocol: rest
  method: POST
  path: /alliance/headquarters/paint
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
    example:
      batchId: <uuid>
      pixels: []
  responses:
    "200":
      description: Painted.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: "`challenge-required`, `verification-required`, `color-not-owned`, `not_enough_hq_charges`, `headquarters_timed_out`, `headquarters_locked` or `no_pixel_changes`."
      schema:
        $ref: Error
    "429":
      description: Painting too fast.
---

**Pawtect:** This request requires an `x-pawtect-token` header, which the client builds for it; see [[Anti-cheat]]. The client reads the response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Like [[Paint-pixels]], this carries a Pawtect token, and a mod must not send it itself. Headquarters use their own charges. **Unverified:** the shape of `pixels`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
