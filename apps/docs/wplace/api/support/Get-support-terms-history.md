---
title: Get the support terms history
description: Get the current support terms and a list of every published version, for the support form and terms page.
tags:
  - source/client
  - source/probe
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /support/terms-history
  auth: none
  responses:
    "200":
      description: The current terms in full, and every version without its text.
      example:
        current:
          version: "1"
          publishedAt: <ISO date>
          effectiveAt: <ISO date>
          notice: <short notice>
          material: false
          content: <terms text>
        versions:
          - version: "1"
            publishedAt: <ISO date>
            effectiveAt: <ISO date>
            notice: <short notice>
            material: false
---

**Pawtect:** No token and no flag: the client fetches this with a plain `fetch`, outside its API client, and without cookies. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request confirmed the response.

The support form and the terms page load this first. The terms page then fetches an older version with [[Get-support-term|Get one support terms version]] when asked for one.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-support-term]], [[Error]].
