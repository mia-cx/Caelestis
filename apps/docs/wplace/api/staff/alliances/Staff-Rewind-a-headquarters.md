---
title: Rewind a headquarters (staff)
description: Staff-only route that shows a headquarters canvas at an earlier time.
tags:
  - source/bundle
  - pawtect/none
  - staff-only
operation:
  protocol: rest
  method: GET
  path: /staff/dashboard/alliances/{allianceId}/headquarters/wayback
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

**Pawtect:** No token and no flag: the dashboard loads this as an image or with a plain `fetch`, outside its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live.

Shows a headquarters canvas at an earlier time.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
