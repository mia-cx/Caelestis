---
title: Upload a profile picture
description: Upload a new profile picture for the signed-in player.
tags:
  - source/community
  - pawtect/flag
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

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Best guess: not called by the client; seen in community API notes (j0code/wplace-api). Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The current client makes pictures on a pixel editor page at `/profile-picture`. **Unverified:** whether this upload route still exists, and its fields.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
