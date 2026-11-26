---
title: Edit a protection (staff)
description: Staff-only route that changes a protected map area's name, schedule, message, pause state or bypass list.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: PUT
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
  requestBody:
    example:
      name: <name>
      season: 0
      startsAt: <ISO date>
      endsAt: <ISO date>
      messageKey: <message key>
      paused: true
      bypassUserIds: []
      revision: 3
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
    "409":
      description: Someone else changed it first; `revision` is stale.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live.

Edits a protected area, including pausing and resuming it. The body is the same as [[Staff-Create-a-protection|creating one]], without `tiles` and with the `revision` the editor last read.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Get-a-protection]], [[Staff-Delete-a-protection]], [[Error]].
