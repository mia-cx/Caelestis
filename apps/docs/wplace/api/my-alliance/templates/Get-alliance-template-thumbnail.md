---
title: Get a template thumbnail
description: Download a small preview of an alliance template.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /alliance/templates/{templateId}/thumbnail
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: templateId
      in: path
      required: true
      type: string
      example: <templateId>
    - name: v
      in: query
      type: string
      example: <thumbnailRevision>
      description: Cache-busting revision.
    - name: target
      in: query
      type: string
      example: main_canvas
      description: Where the template applies.
    - name: draftId
      in: query
      type: integer
      example: 1
      description: For an asset draft target.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: The thumbnail.
      contentType: image/png
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
