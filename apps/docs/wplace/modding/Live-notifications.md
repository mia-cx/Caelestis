---
title: Live notifications
description: How the Wplace page keeps its notification inbox live over server-sent events, and how a mod can listen in without opening a second stream.
tags: [source/client, pawtect/none]
symbol:
  kind: interface
  name: NotificationStreamEvent
  signature: "new EventSource('https://backend.wplace.live/notification/stream', { withCredentials: true })"
  members:
    - { name: heartbeat, kind: property, signature: "event: heartbeat", description: "Keep-alive. The client reconnects if 55 seconds pass without an event." }
    - { name: notifications, kind: property, signature: "event: notifications  data: { ids?: number[]; created?: boolean; reset?: boolean }", description: "Notifications changed. `ids` lists up to 100 changed notification ids. `created` means a new one arrived. `reset` means reload them all." }
---

**Pawtect:** none. The stream is not a `fetch`, so Pawtect's URL log does not see it, and no token covers it.

Wplace's client opens no WebSocket. It has two server-sent event streams, both for signed-in players: [`/notification/stream`](api/notifications/Notification-stream) for the notification inbox, and [`/support/stream`](api/support/Support-stream) for support tickets. Pixel changes do not stream: the page learns about them by reloading tiles ([Watching tiles](Watching-tiles)).

The page opens the stream with `EventSource` and the player's cookies. It reconnects with exponential backoff, from 2 seconds up to about a minute. When an event names changed ids, it fetches those notifications from the API. It also re-checks every 25–35 seconds, and when the tab becomes visible again.

## Observing it

Wrap the page's `EventSource` constructor at document start and add your own listeners to the instance. Don't open a second stream for the same player: it doubles the server's load, and the stream only tells you that something changed.

## Not verified live

A signed-out page never opens the stream. Everything here comes from the client code of 26 November 2026. The event payload shape is inferred from how the client parses it.

## Related

- [Stream notifications](api/notifications/Notification-stream), the endpoint itself
- [Get notification changes](api/notifications/Get-notification-changes), which the page calls after an event
- [fetch](Page-fetch)
- [Globals and page events](Globals-and-page-events)
