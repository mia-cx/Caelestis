---
title: Link Discord
description: Start linking a Discord account to the signed-in player.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /discord/authorize
  client: browser
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
  responses:
    "302":
      description: On to Discord.
      empty: true
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

A link on the profile page. **Unverified:** the redirect.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Unlink-discord]], [[Error]].
