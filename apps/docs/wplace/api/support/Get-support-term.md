---
title: Get one support terms version
description: Get one published version of the support terms, with its dates and full text.
tags:
  - source/client
  - source/probe
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /support/terms/{version}
  auth: none
  parameters:
    - name: version
      in: path
      required: true
      type: string
      example: "1"
      description: A `version` from [[Get-support-terms-history|the terms history]].
  responses:
    "200":
      description: That version of the terms.
      example:
        version: "1"
        publishedAt: <ISO date>
        effectiveAt: <ISO date>
        notice: <short notice>
        material: false
        content: <terms text>
---

**Pawtect:** No token and no flag: the client fetches this with a plain `fetch`, outside its API client, and without cookies. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: an anonymous request confirmed the response.

The terms page loads this when its `version` URL parameter names an older version than the current one.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-support-terms-history]], [[Error]].
