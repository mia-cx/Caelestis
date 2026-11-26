---
title: Get an alliance banner
description: Download an alliance's profile banner by id and version.
tags:
  - source/client
  - source/probe
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /alliances/{allianceId}/assets/banner
  auth: none
  parameters:
    - name: allianceId
      in: path
      required: true
      type: integer
      example: 12345
      description: Alliance id.
    - name: v
      in: query
      type: integer
      example: 140
      required: true
      description: The alliance's `bannerVersionId`. Required.
  responses:
    "200":
      description: The banner.
      contentType: image/png
    "404":
      description: Missing `v`.
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-picture]].
