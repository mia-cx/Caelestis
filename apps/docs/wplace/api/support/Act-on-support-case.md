---
title: Reply to a support ticket
description: Reply to or act on one of the player's support tickets.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /support/cases/{caseId}/actions
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: caseId
      in: path
      required: true
      type: string
      example: <caseId>
    - name: Idempotency-Key
      in: header
      required: true
      type: string
      example: <uuid>
      description: Makes retries safe.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      attachments: []
  responses:
    "200":
      description: Updated ticket.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
