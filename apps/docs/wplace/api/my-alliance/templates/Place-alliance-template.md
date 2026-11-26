---
title: Move an alliance template
description: Change where on the map an alliance template sits.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: PATCH
  path: /alliance/templates/{templateId}/placement
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: templateId
      in: path
      required: true
      type: string
      example: <templateId>
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      target: main_canvas
      x: 1037000
      y: 704000
      width: 200
      height: 200
      opacity: 60
      colorMetric: lab
      dithering: false
      colorPaletteMode: all
      pixelMode: normal
  responses:
    "200":
      description: Saved.
    "400":
      description: "`invalid_template_placement` or `template_location_not_selected`."
      schema:
        $ref: Error
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: The player's role may not do this.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The client sends one flat placement. `target` is `main_canvas` for the world map or `headquarters` for the alliance headquarters. `x` and `y` are the top-left pixel, `opacity` is a whole percentage, and the rest are the template's display settings. **Unverified:** which fields the server requires.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
