---
title: Edit a favourite place
description: Rename a favourite or move it into a folder.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /favorite-location/update
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      id: 1
      name: Home
      folderId: 0
  responses:
    "200":
      description: Saved.
    "400":
      description: Invalid details.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "404":
      description: No such favourite.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

`folderId` 0 means no folder. **Unverified:** fields other than `id` and `folderId`.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
