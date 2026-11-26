---
title: Add a player note (staff)
description: Staff-only route that adds a staff note to one player from the staff dashboard.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/dashboard/users/notes
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
  parameters:
    - name: userId
      in: query
      required: true
      type: integer
      example: 1000001
      description: Player id.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      userId: 1000001
      note: <note>
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

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live.

Adds a staff note to one player. The player id goes in both the query and the body.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Get-player-notes]], [[Error]].
