---
title: Get an alliance
description: "Get an alliance's public profile by id: description, members, awards and headquarters."
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliances/{allianceId}
  auth: none
  parameters:
    - name: allianceId
      in: path
      required: true
      type: integer
      example: 12345
      description: Alliance id.
  responses:
    "200":
      description: The public profile.
      schema:
        $ref: Alliance-profile
    "404":
      description: No alliance with this id.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[List-alliance-members]], [[List-alliance-awards]], [[Get-alliance-headquarters]], [[Get-alliance-picture]], [[Get-alliance-banner]], [[Alliance-profile]], [[Error]].
