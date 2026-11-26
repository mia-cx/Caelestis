---
title: Look up accounts by id (staff)
description: Staff-only route that returns account info for a list of user ids, used to name the painters found in an area or on a tile.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/tools/select-area/users
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
    schema:
      type: object
      properties:
        userIds:
          type: array
          description: The user ids to look up.
          items:
            type: integer
    example:
      userIds:
        - 1
        - 2
  responses:
    "200":
      description: "`{ users: [...] }`, one entry per account found, each with at least `id`, `name` and `allianceName`."
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

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live. Read from the client's API module, chunk `BcgqpPa1.js`, on 26 November 2026.

Returns account info for the user ids in the body. The client method is `getMultipleUsersInfoById`. The route takes ids, not an area, despite its `select-area` path.

The staff area tool calls it second. [[Staff-Inspect-an-area]] first returns the painter id of every pixel, and this route then turns those ids into names. The staff tile history tool does the same for the ids in [[Staff-List-paint-events-on-a-tile]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Inspect-an-area]], [[Error]].
