---
title: Upload an alliance template
description: Upload a new template image for the alliance, with its audience and placement.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /alliance/templates
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
  requestBody:
    contentType: multipart/form-data
    example:
      idempotencyKey: <uuid>
      name: Mural
      audienceAllMembers: "true"
      audienceRoles: "[]"
      audienceUserIds: "[]"
      locations: "[]"
      opacity: "0.5"
      colorMetric: <metric>
      dithering: "false"
      colorPaletteMode: <mode>
      pixelMode: <mode>
      image: <png file>
  responses:
    "200":
      description: The new template.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: The player's role may not do this.
      schema:
        $ref: Error
    "429":
      description: "`template_upload_rate_limited`."
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
