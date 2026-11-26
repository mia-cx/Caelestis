---
title: List my alliance's members
description: List members of the player's own alliance, with the fields only members see.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliance/members/{page}
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: page
      in: path
      required: true
      type: integer
      example: 0
      description: Page, from 0.
    - name: role
      in: query
      type: string
      example: all
      required: true
      description: Filter by role.
    - name: sort
      in: query
      type: string
      example: default
      required: true
      description: Sort order.
    - name: q
      in: query
      type: string
      example: name
      description: Search by name.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: One page of members.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[List-alliance-members]], [[Error]].
