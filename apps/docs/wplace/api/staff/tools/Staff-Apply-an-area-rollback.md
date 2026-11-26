---
title: Apply an area rollback (staff)
description: Staff-only route that rolls an area back to an earlier time.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/tools/select-area/reverse/apply
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
        mode:
          type: string
        snapshotDepth:
          type: integer
        timestamp:
          type: integer
    example:
      sessionId: <session-id>
      mode: depth
      snapshotDepth: 1
  responses:
    "200":
      description: OK.
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

Rolls an area back to an earlier time, for a session from [[Staff-Start-an-area-rollback]]. The client method is `applyReverse`. It takes the same point as [[Staff-Preview-an-area-rollback]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Preview-an-area-rollback]], [[Error]].
