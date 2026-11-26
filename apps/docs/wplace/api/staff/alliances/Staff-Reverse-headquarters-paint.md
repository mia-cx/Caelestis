---
title: Reverse headquarters paint (staff)
description: Staff-only route that undoes paint on a headquarters.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/dashboard/alliances/{allianceId}/headquarters/reverse
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
  parameters:
    - name: allianceId
      in: path
      required: true
      type: integer
      example: 12345
      description: Alliance id.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      pixels:
        - x: -12
          y: 40
          eventId: <eventId>
      reason: <reason>
      clear: true
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

Undoes paint on a headquarters.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
