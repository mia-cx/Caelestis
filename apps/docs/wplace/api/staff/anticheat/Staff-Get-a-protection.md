---
title: Get a protection (staff)
description: Staff-only route that returns one protected map area, with its tiles, schedule and bypass list.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: GET
  path: /staff/dashboard/protections/{protectionId}
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
  parameters:
    - name: protectionId
      in: path
      required: true
      type: string
      example: <protectionId>
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: The protection.
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

Returns one protected area. Best guess: paints inside an active protection are the ones [[Paint-pixels]] refuses with `pixel-protected`, since both carry a `messageKey`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-List-protections]], [[Staff-Create-a-protection]], [[Error]].
