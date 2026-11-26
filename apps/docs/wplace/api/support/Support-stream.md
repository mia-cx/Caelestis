---
title: Stream support updates
description: Receive support ticket changes as server-sent events while the page is open.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: GET
  path: /support/stream
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
      description: An event stream with `heartbeat` and `support` events.
      contentType: text/event-stream
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token and no flag: the client opens this with `EventSource`, not `fetch`, so it is neither checked nor logged.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The client opens an `EventSource` with credentials while the tab is visible and online. A `support` event carries a JSON object whose `true` keys name which support data changed; the client then reloads those. Without an event for 55 seconds, it reconnects with backoff, and it falls back to polling every 30 seconds while disconnected. **Unverified:** the names of the keys.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Notification-stream]], [[Live-notifications]], [[Error]].
