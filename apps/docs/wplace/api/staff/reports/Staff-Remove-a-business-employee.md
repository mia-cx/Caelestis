---
title: Remove a business employee (staff)
description: Staff-only route that removes an employee from a business account.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: DELETE
  path: /staff/dashboard/businesses/{businessId}/employees/{userId}
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
  parameters:
    - name: businessId
      in: path
      required: true
      type: string
      example: <businessId>
    - name: userId
      in: path
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

Removes an employee from a business account.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
