---
title: Get alliance history (staff)
description: Staff-only route that shows an alliance's change history.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: GET
  path: /staff/dashboard/alliances/{allianceId}/history
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
    - name: before
      in: query
      type: string
      example: <cursor>
      description: Page back from this point.
    - name: limit
      in: query
      type: integer
      example: 50
    - name: category
      in: query
      type: string
      example: <category>
    - name: source
      in: query
      type: string
      example: <source>
    - name: userId
      in: query
      type: integer
      example: 1000001
      description: Only events by this player.
    - name: includePaint
      in: query
      type: boolean
      example: true
      description: Include paint events.
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

Shows an alliance's change history.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
