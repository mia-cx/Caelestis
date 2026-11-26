---
title: Update privacy settings
description: "Save the four privacy settings: last pixel, Discord, hotspots and headquarters pins."
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /me/privacy
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
      showLastPixel: true
      showDiscord: false
      hotspotsOptOut: true
      hideAllianceHqPins: false
  responses:
    "200":
      description: Saved settings.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

| Setting | What it changes |
| --- | --- |
| `showLastPixel` | Whether your alliance's leaderboard shows your last painted pixel location |
| `showDiscord` | Whether leaderboards, profiles and pixel lookups show your Discord handle |
| `hotspotsOptOut` | Whether your painting counts toward the public [[Get-hotspots\|hotspots]] list |
| `hideAllianceHqPins` | Whether your own map shows alliance headquarters pins |

None of these hides a player from [[Get-pixel]]: anyone who clicks a pixel sees who painted it. The client sends only the changed fields. Requests time out after 15 seconds.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
