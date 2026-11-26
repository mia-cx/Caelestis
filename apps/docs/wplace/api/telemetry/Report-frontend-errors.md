---
title: Report client errors
description: The client's error reporter, which sends batches of page errors and unhandled rejections to Wplace.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: POST
  path: /frontend/errors
  auth: none
  requestBody:
    contentType: text/plain
    example: '{"visitorId":"<visitor id>","sessionId":"<session id>","appVersion":"<build>","playerBuild":"<player build>","staleBuild":false,"errors":[],"dropped":0}'
  responses:
    "200":
      description: Delivered.
    "400":
      description: Rejected. The client drops the batch.
---

**Pawtect:** No token and no flag: the client sends this with `navigator.sendBeacon` or a plain `fetch`, outside its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code; the guide sends no error reports.

The reporter listens for `error` and `unhandledrejection` on `window`, batches what it catches, and flushes on `pagehide` or when the tab is hidden. The body is a JSON string with the visitor id from `localStorage['wplace:visitor-id']`, a per-page session id, the build versions, the `errors` list and a `dropped` count. It sends cookies when it can. **Unverified:** the fields of each error, and which errors from other origins it filters out.

Not covered by the measured [[Rate-limits|rate limits]].

Related: [[Record-frontend-telemetry]].
