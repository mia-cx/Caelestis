---
title: Get alliance report evidence (staff)
description: Staff-only route that shows the evidence attached to an alliance report.
tags:
  - source/bundle
  - pawtect/none
  - staff-only
operation:
  protocol: rest
  method: GET
  path: /staff/dashboard/alliances/{allianceId}/reports/{reportId}/evidence
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
    - name: reportId
      in: path
      required: true
      type: string
      example: <reportId>
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

**Pawtect:** No token and no flag: the dashboard loads this as an image URL, outside its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live.

Shows the evidence attached to an alliance report.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
