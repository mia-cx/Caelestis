---
title: Upload a profile picture
description: Upload a new profile picture for the signed-in player.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: POST
  path: /me/profile-picture
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
    contentType: multipart/form-data
    example:
      image: <png file>
  responses:
    "200":
      description: Uploaded.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token and no flag: the client sends this with a plain `fetch`, outside its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The pixel editor page at `/profile-picture` sends the finished picture as a PNG in the multipart field `image`. It treats any status other than 200 as a failure.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
