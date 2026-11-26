---
title: Get my account
description: "Get the signed-in player's account: charges, droplets, owned colours and profile."
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /me
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
    "200":
      description: The account.
      schema:
        $ref: Me
    "401":
      description: Not signed in.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Changing `maxFavoriteLocations` to `Infinity` sets "Tampered profile limits". Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request got `401`. **Unverified:** the signed-in response, read from the client code, since the guide makes no signed-in requests.

The client calls this at start and again when the account changes. A mod that needs the player's charges or owned colours can watch the client's own `/me` response instead of sending another.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Paint-pixels]], [[Update-me]], [[Me]], [[Error]].
