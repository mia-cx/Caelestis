---
title: Set business charges (staff)
description: Staff-only route that changes a business account's paint charges.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: PATCH
  path: /staff/dashboard/businesses/{businessId}/charges
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
  parameters:
    - name: businessId
      in: path
      required: true
      type: string
      example: <businessId>
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      infinite: true
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

Changes a business account's paint charges.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
