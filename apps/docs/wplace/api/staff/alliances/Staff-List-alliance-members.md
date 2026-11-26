---
title: List alliance members (staff)
description: Staff-only route that lists an alliance's members with staff fields.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: GET
  path: /staff/dashboard/alliances/{allianceId}/members
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
    - name: page
      in: query
      type: integer
      example: 1
    - name: pageSize
      in: query
      type: integer
      example: 50
    - name: role
      in: query
      type: string
      example: <role filter>
    - name: status
      in: query
      type: string
      example: <status filter>
    - name: sort
      in: query
      type: string
      example: <sort order>
    - name: q
      in: query
      type: string
      example: <search text>
      description: Optional name search.
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

Lists an alliance's members with staff fields.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
