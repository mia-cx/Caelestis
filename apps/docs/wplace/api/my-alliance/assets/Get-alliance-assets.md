---
title: List alliance asset versions
description: List the drafts and published versions of the alliance picture, banner or canvas.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliance/assets/{kind}
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: kind
      in: path
      required: true
      type: string
      example: picture
      description: "Which asset: seen `picture`, `banner`."
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  responses:
    "200":
      description: Drafts and versions.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

Alliances paint their picture and banner pixel by pixel, in drafts. **Unverified:** the full list of asset kinds.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
