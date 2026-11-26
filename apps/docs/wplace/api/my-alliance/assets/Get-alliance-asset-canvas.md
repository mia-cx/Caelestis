---
title: Get a draft canvas
description: Get the pixels or the revision of an alliance asset draft.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliance/assets/drafts/{draftId}/canvas
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: draftId
      in: path
      required: true
      type: string
      example: <draftId>
    - name: metadataOnly
      in: query
      type: boolean
      example: true
      description: Only the revision.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: The canvas.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "403":
      description: Not an editor.
    "404":
      description: No such draft.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
