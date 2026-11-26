---
title: Create a protection (staff)
description: Staff-only route that protects a set of map tiles from painting for a scheduled time.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/dashboard/protections
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
      name: <name>
      season: 0
      startsAt: <ISO date>
      endsAt: <ISO date>
      messageKey: <message key>
      paused: false
      bypassUserIds: [1000001]
      tiles: [<tile>]
  responses:
    "200":
      description: The saved protection.
    "400":
      description: Invalid protection, or `protection_bypass_user` for an unknown bypass player.
      schema:
        $ref: Error
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

Creates a protected area. `messageKey` picks the message players see when a paint is refused, and `bypassUserIds` lists players who may still paint there. **Unverified:** the shape of each entry in `tiles`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Edit-a-protection]], [[Staff-List-protections]], [[Error]].
