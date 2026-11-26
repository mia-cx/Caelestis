---
title: Start an area rollback (staff)
description: Staff-only route that opens a rollback session for an area, from a binary description of the selection.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/tools/select-area/reverse/session
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
    contentType: application/octet-stream
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

Starts a rollback session for an area. The client method is `createReverseSession`. It posts the selection as raw bytes (`application/octet-stream`) and reads back JSON with the session id. **Unverified:** the byte layout, which the dashboard builds.

The session id then drives [[Staff-List-rollback-points]], [[Staff-Preview-an-area-rollback]], [[Staff-Get-an-area-timelapse]] and [[Staff-Apply-an-area-rollback]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-List-rollback-points]], [[Error]].
