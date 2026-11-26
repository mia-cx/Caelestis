---
title: Get the current support terms
description: Get the support terms in force now, with their version, dates and full text.
tags:
  - source/bundle
  - source/probe
  - pawtect/flag
operation:
  protocol: rest
  method: GET
  path: /support/terms
  auth: none
  responses:
    "200":
      description: The current terms.
      example:
        version: "1"
        publishedAt: <ISO date>
        effectiveAt: <ISO date>
        notice: <short notice>
        material: false
        content: <terms text>
---

**Pawtect:** No token. The bundle's helper for this route reads the response through the API client, so patching its `json` or `text` would set "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

In the client bundle, never called by the player UI. Checked on 26 November 2026: an anonymous request got `200` with the fields above.

The support pages read the terms through [[Get-support-terms-history|Get the support terms history]] and [[Get-support-term|Get one support terms version]] instead.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
