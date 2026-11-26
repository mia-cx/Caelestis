---
title: Report an alliance
description: Report an alliance's headquarters or assets, with the area and view attached.
tags:
  - source/client
  - pawtect/token
operation:
  protocol: rest
  method: POST
  path: /report/alliance
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
      allianceId: 12345
      target: headquarters
      targetId: 0
      eventHwm: 575802
      area: {}
      zoom: 2
      viewport: {}
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
      description: Refused or challenged.
---

**Pawtect:** This request requires an `x-pawtect-token` header, which the client builds for it; see [[Anti-cheat]]. The client reads the response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
