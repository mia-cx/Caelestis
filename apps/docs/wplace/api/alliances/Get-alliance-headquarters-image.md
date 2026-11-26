---
title: Get a headquarters image
description: Download an alliance's whole headquarters canvas as one image.
tags:
  - source/client
  - source/probe
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /alliances/{allianceId}/headquarters/image
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
      example: 575802
      required: true
      description: Version, the headquarters `eventHwm`. Required.
  responses:
    "200":
      description: The canvas image.
      contentType: image/png
    "404":
      description: Missing `v`.
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

Without `v` the server answers `404`. A community archiver reports that this path redirects to the image file. The client loads it as an `<img>`, outside the API client.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Get-alliance-headquarters]].
