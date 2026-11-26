---
title: ServiceWorkerMessage
description: The messages wplace.live's page and its service worker exchange about draft pixels and tile refreshes, and how to observe them.
tags: [source/caelestis, pawtect/none]
symbol:
  kind: interface
  name: ServiceWorkerMessage
  signature: "type ServiceWorkerMessage = { type: 'previewPixels' | 'clearPixelPreview' | 'paintPixels' | 'unpaintPixels' | 'refreshPixelArt'; id: number; data?: PreviewPixel[] }"
  members:
    - { name: previewPixels, kind: property, signature: "{ type: 'previewPixels'; id: number; data: PreviewPixel[] }", description: "The player's whole current draft. The worker draws it into this tab's tile responses." }
    - { name: clearPixelPreview, kind: property, signature: "{ type: 'clearPixelPreview'; id: number }", description: "No draft. Sent every 5 seconds even when nothing is drafted." }
    - { name: paintPixels, kind: property, signature: "{ type: 'paintPixels'; id: number; data: PreviewPixel[] }", description: "Pixels the server accepted. The worker keeps drawing them until fresh tiles show them. Replies `refreshPixelArt`." }
    - { name: unpaintPixels, kind: property, signature: "{ type: 'unpaintPixels'; id: number; data: PreviewPixel[] }", description: "Drop pixels from that list." }
    - { name: refreshPixelArt, kind: property, signature: "{ type: 'refreshPixelArt'; id: number }", description: "Ask for a tile refresh. Replies `refreshPixelArt`." }
    - { name: PreviewPixel, kind: property, signature: "{ tile: [x: number, y: number]; pixel: [x: number, y: number]; season: number; color: { r: number; g: number; b: number; a: number } }", description: "One pixel, in tile and tile-local coordinates." }
  source: https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-tile-refresh.ts
---

**Pawtect:** none. Service worker messages are not part of any token. Observe them; don't post your own. A forged `previewPixels` changes what the player's tiles show.

wplace.live registers a service worker at `https://wplace.live/service-worker.js`, scoped to the whole site. It answers the page's tile requests ([Watching tiles](Watching-tiles)):

- With no draft and no recent paint, it passes tile requests straight to the network.
- While a tab has a draft, it keeps that tab's tiles in memory, never in Cache Storage. It serves a copy younger than the refresh interval, and falls back to its copy or a blank tile when the network fails.
- It draws the tab's draft pixels into each tile it returns, per tab.
- It keeps recently painted pixels in its tiles until the server's tiles show them.
- It turns a `404` tile into a transparent PNG: 1 × 1 when it passes the request through, full tile size while it draws.
- It skips non-`GET` requests and requests with `Accept: text/event-stream`.

Drawing drafts in is costly. From Caelestis's research on 24 September 2026, the worker keeps up to 64 decoded tiles, and decodes, draws into and re-encodes every tile it serves while a draft exists, including tiles with no drafts on them. One re-encoded tile was 1.59 MB, against 218 KB from the server ([How Wplace renders the map](Map-rendering)).

## The protocol

The page posts a message with a numeric `id` to `navigator.serviceWorker.controller`. The worker always replies to that tab with `{ id, type }`. `type` is `"refreshPixelArt"` when the page should reload its tiles, and absent otherwise. The page gives up after 10 seconds.

The worker also sends `{ type: "refreshPixelArt" }` with no `id` after it refreshed a tile in the background. On a notification click it can send `{ type: "openNotificationInbox" }`.

Observed live on 26 November 2026, signed out: only `clearPixelPreview`, every 5 seconds from about 5 s after load. The other types come from the client and worker code.

## Observing it

Wrap `ServiceWorker.prototype.postMessage` at document start, before Wplace sends anything, and listen on `navigator.serviceWorker` for replies.

```ts
const nativePost = ServiceWorker.prototype.postMessage
ServiceWorker.prototype.postMessage = function (this: ServiceWorker, message: unknown, ...rest: unknown[]) {
  const result = Reflect.apply(nativePost, this, [message, ...rest])
  try {
    const { type, data } = (message ?? {}) as { type?: string; data?: unknown }
    if (type === 'previewPixels' && Array.isArray(data)) onDraft(data)
    if (type === 'clearPixelPreview') onDraft([])
  } catch {
    // Observation must never break the page's message.
  }
  return result
} as typeof nativePost

navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'refreshPixelArt') onTilesRefreshing()
})
```

Caelestis uses this to reload only the tiles whose draft changed, instead of every visible tile ([`wplace-tile-refresh.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-tile-refresh.ts)). It treats `clearPixelPreview` as a change only when the draft really was non-empty, because Wplace sends it on a timer.

## Stability

Message type names are Wplace's own strings, not minified. The worker script can change with any release.

## Related

- [Draft canvases](Draft-canvases)
- [Watching tiles](Watching-tiles)
- [Storage keys](Storage-keys)
