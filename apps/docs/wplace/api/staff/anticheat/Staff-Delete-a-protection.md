---
title: Delete a protection (staff)
description: Staff-only route that removes a protected map area, at the revision staff last saw.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: DELETE
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
    - name: revision
      in: query
      required: true
      type: integer
      example: 3
      description: The revision staff last read.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: Deleted.
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

Removes a protected area.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Get-a-protection]], [[Staff-List-protections]], [[Error]].
