---
title: Stream notifications
description: Receive new notifications as server-sent events while the page is open.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /notification/stream
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
  responses:
    "200":
      description: An event stream with `heartbeat` and `notifications` events.
      contentType: text/event-stream
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The client opens an `EventSource` with credentials. A `notifications` event carries JSON with `ids`, `created` and `reset`; the client then fetches details with [[Get-notification-changes]]. Without a heartbeat for 55 seconds, the client reconnects. **Unverified:** event fields beyond these.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
