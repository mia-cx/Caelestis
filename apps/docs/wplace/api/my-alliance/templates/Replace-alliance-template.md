---
title: Replace an alliance template
description: Replace a template's image and settings.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: PUT
  path: /alliance/templates/{templateId}
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
    contentType: multipart/form-data
    example:
      name: Mural
      image: <png file>
  responses:
    "200":
      description: Saved.
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

Takes the same fields as [[Create-alliance-template]], without `idempotencyKey`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
