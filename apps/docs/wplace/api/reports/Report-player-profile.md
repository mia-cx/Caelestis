---
title: Report a player's profile
description: Report a player's name or picture, with the content the reporter saw.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /report/user/profile
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
      userId: 1000001
      target: picture
      name: ExamplePlayer
      pictureUrl: https://files.wplace.live/example.png
      reason: inappropriate-content
      notes: ""
  responses:
    "200":
      description: "`success`, or a `reason`: `target_cooldown`, `reporter_banned`, `min_pixels_painted`, or a daily report limit."
      example:
        success: true
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "409":
      description: The profile changed since the reporter saw it.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
