---
title: Suspend accounts from an area (staff)
description: Staff-only route the area tool uses to suspend accounts it found; the last path segment comes from the staff dashboard.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/tools/select-area/{action}
  auth:
    scheme: staff session
    description: The `j` cookie of a Wplace staff account.
  parameters:
    - name: action
      in: path
      required: true
      type: string
      example: <action>
      description: Chosen by the staff dashboard. The caller was not found in the loaded client.
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

Staff only: the staff dashboard in the client bundle calls it, and players can't use it. Not called live. Read from the client's API module, chunk `BcgqpPa1.js`, on 26 November 2026.

Suspends accounts from the staff area tool. The client method is `postUsersSuspend`, which picks this path when its source is `select-area`. It sends a JSON body built by the dashboard. **Unverified:** the body and the values of `{action}`, because the dashboard code that calls it was not among the chunks fetched.

The same method posts to [[Staff-Suspend-accounts-from-a-pixel]] for the pixel tool, and to `/staff/dashboard/users/{action}` and `/staff/dashboard/summary/users/{action}` from the dashboard's user pages.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Inspect-an-area]], [[Staff-Look-up-accounts-by-id]], [[Error]].
