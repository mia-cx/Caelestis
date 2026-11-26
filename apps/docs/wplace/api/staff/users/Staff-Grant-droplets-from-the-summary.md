---
title: Grant droplets from the summary (staff)
description: Staff-only route that adds droplets from the staff summary page.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/dashboard/summary/users/increment-droplet
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
    example:
      userIds: [1000001]
      delta: 500
      notes: <notes>
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

Adds droplets from the staff summary page.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
