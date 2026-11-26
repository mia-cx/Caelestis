---
title: Submit a challenge result
description: Submit a solved proof of work, captcha or phone code after a challenge.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /anticheat/challenge/verify
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: x-fp
      in: header
      required: true
      type: string
      example: <fingerprint hash>
      description: The FingerprintJS device hash.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      code: <code>
  responses:
    "200":
      description: Accepted.
    "400":
      description: Invalid code.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
    "410":
      description: Expired code.
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Like every anti-cheat request, this page describes the request only. Leave challenges to the player; see [[Anti-cheat]].

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
