---
title: Get an area timelapse (staff)
description: Staff-only route that renders a rollback session's paint history as a binary timelapse.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/tools/select-area/reverse/timelapse
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
  parameters:
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    schema:
      type: object
      properties:
        sessionId:
          type: string
        paceMode:
          type: string
        fps:
          type: integer
        durationSeconds:
          type: integer
        maxFrameCount:
          type: integer
        beforeTimestamp:
          type: integer
    example:
      sessionId: <session-id>
      fps: 12
      durationSeconds: 10
      beforeTimestamp: 0
  responses:
    "200":
      description: The timelapse, as binary.
      contentType: application/octet-stream
    "400":
      description: "`timelapse_too_many_events` when the area's history is too long."
    "401":
      description: No session.
      schema:
        $ref: Error
    "403":
      description: The account is not staff.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live. Read from the client's API module, chunk `BcgqpPa1.js`, on 26 November 2026.

Renders the paint history of a session from [[Staff-Start-an-area-rollback]]. The client method is `getReverseTimelapse`, and it reads the answer as an `ArrayBuffer`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Start-an-area-rollback]], [[Error]].
