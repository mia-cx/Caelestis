---
title: List an alliance's members
description: List an alliance's public members and roles, 50 per page.
tags:
  - source/client
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /alliances/{allianceId}/members
  auth: none
  parameters:
    - name: allianceId
      in: path
      required: true
      type: integer
      example: 12345
      description: Alliance id.
    - name: page
      in: query
      type: integer
      example: 0
      required: true
      description: Page, from 0.
    - name: role
      in: query
      type: string
      example: all
      required: true
      description: "Filter by role. Seen: `all`, `admin`."
    - name: sort
      in: query
      type: string
      example: default
      required: true
      description: Sort order.
    - name: q
      in: query
      type: string
      example: name
      description: Search by name.
  responses:
    "200":
      description: One page of members.
      schema:
        $ref: Alliance-members-page
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance]], [[Alliance-members-page]].
