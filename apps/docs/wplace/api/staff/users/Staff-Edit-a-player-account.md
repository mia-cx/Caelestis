---
title: Change a player's cosmetics (staff)
description: Staff-only route that grants, removes or refunds one player's badges and cosmetics.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/dashboard/users/{kind}/{action}
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
  parameters:
    - name: kind
      in: path
      required: true
      type: string
      example: cosmetics
      description: "`badges` or `cosmetics`."
    - name: action
      in: path
      required: true
      type: string
      example: grant
      description: "`grant` or `remove` for badges; `grant`, `remove` or `refund` for cosmetics."
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      userId: 1000001
      cosmeticId: <cosmeticId>
      reason: <reason>
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

Grants, removes or refunds a player's badges and cosmetics. The body always has `userId` and `reason`. Granting names the item by `badgeId` or `cosmeticId`. Removing a badge names its `badgeId`; removing or refunding a cosmetic names its `tag`. On failure the dashboard reads an `error` of `already_owned`, `not_owned`, `not_refundable` or `user_not_found`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-List-a-player-cosmetics]], [[Staff-List-grantable-cosmetics]], [[Error]].
