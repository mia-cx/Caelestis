---
title: Get the web app version
description: Check which wplace.live build is live, to notice a new client release.
tags:
  - source/client
  - source/probe
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /_app/version.json
  server: https://wplace.live
  auth: none
  responses:
    "200":
      description: The build version.
      schema:
        $ref: App-version
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026: a browser recording saw the client send it, and an anonymous request confirmed the response.

The client polls this and offers a reload when `version` changes. A mod can use it to notice a client update that might move the hooks it relies on.

Not covered by the measured [[Rate-limits|rate limits]]; this host's limit is unmeasured.

Related: [[Get-health]], [[App-version]].
