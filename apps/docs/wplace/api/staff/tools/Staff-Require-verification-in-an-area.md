---
title: Require verification in an area (staff)
description: Staff-only route that requires phone verification from the accounts staff picked in the area tool, by user id.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/tools/select-area/phone-verification
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
          items:
            type: integer
        notes:
          type: string
    example:
      userIds:
        - 1
      notes: ""
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

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live. Read from the client's API module, chunk `BcgqpPa1.js`, on 26 November 2026.

Requires phone verification from the accounts in `userIds`. The client method is `postSelectAreaPhoneVerification`. The area tool gets those ids from [[Staff-Inspect-an-area]], so the route itself takes no area.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Inspect-an-area]], [[Staff-Require-phone-verification]], [[Error]].
