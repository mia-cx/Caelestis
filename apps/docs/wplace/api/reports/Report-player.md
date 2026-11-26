---
title: Report a player
description: Report a player for griefing or another rule break, with the map view attached.
tags:
  - source/client
  - pawtect/token
operation:
  protocol: rest
  method: POST
  path: /report-user
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
      description: Built by the client over an empty body, not the form. See [[Anti-cheat]].
  requestBody:
    contentType: multipart/form-data
    example:
      reportedUserId: "1000001"
      latitude: "48.85"
      longitude: "2.35"
      viewportNorth: "48.86"
      viewportSouth: "48.84"
      viewportWest: "2.34"
      viewportEast: "2.36"
      viewportWidth: "1400"
      viewportHeight: "900"
      reason: griefing
      notes: ""
  responses:
    "200":
      description: Reported.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: "`challenge-required`, or a Cloudflare challenge."
      schema:
        $ref: Error
---

**Pawtect:** This request requires an `x-pawtect-token` header, which the client builds for it; see [[Anti-cheat]]. The client sends it with a plain `fetch`, outside its API client, so its response sets no flag. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The client sends a Pawtect token built over an empty body. Community notes add `zoom` and a screenshot `image`; **unverified** in the current client. Reasons include `griefing`, `multi-accounting`, `hate-speech`, `bot`, `doxxing` and `inappropriate-content`. A plain `GET` on this path meets a Cloudflare challenge.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
