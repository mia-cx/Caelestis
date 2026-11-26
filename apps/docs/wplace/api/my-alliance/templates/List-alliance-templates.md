---
title: List alliance templates
description: List the templates the player's alliance shares, with storage use.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliance/templates
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: target
      in: query
      type: string
      example: main_canvas
      description: Where the templates apply.
    - name: draftId
      in: query
      type: integer
      example: 1
      description: With `target` for an asset draft.
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: Templates, `usedBytes` and `byteLimit` (64 MiB by default), and `draftOptions`.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request got `401`. **Unverified:** the signed-in response, read from the client code, since the guide makes no signed-in requests.

Alliance templates are image overlays that leaders share with members.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-template-image]], [[Error]].
