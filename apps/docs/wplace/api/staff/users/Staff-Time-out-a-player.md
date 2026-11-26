---
title: Time out a player (staff)
description: Staff-only route that stops a player painting for a while.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/dashboard/summary/users/timeout
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
      imageBase64: <base64 screenshot>
      latitude: 0
      longitude: 0
      zoom: 0
      reason: <reason>
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

Stops a player painting for a while. The dashboard's summary page sends this through its shared punishment request, with a screenshot, a map position and the reason. The API module also has an older method for this route that sends only `userIds`, `reason` and `notes`, but nothing calls it.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
