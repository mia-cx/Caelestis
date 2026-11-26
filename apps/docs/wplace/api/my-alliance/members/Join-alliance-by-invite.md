---
title: Join with an invite link
description: Join an alliance through an invite link code.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /alliance/join/{invite}
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: invite
      in: path
      required: true
      type: string
      example: <invite>
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: Joined.
    "208":
      description: Already in another alliance.
    "400":
      description: Invalid invite.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: Banned from the alliance.
    "404":
      description: Invalid invite.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The status code alone tells the outcome; the client reads no body. Invite links on wplace.live end in this code.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Join-open-alliance]], [[Error]].
