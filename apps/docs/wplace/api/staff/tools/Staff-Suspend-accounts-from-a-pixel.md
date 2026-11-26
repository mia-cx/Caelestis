---
title: Suspend accounts from a pixel (staff)
description: Staff-only route the pixel tool uses to suspend accounts; the last path segment comes from the staff dashboard.
tags:
  - source/bundle
  - pawtect/flag
  - staff-only
operation:
  protocol: rest
  method: POST
  path: /staff/tools/select-pixel/{action}
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

Suspends accounts from the staff pixel tool. It does not read a pixel. The client method is `postUsersSuspend`, which falls back to this path for any source other than the dashboard, the summary or the area tool. It sends a JSON body built by the dashboard. **Unverified:** the body and the values of `{action}`, because the dashboard code that calls it was not among the chunks fetched.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Staff-Suspend-accounts-from-an-area]], [[Error]].
