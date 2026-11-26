---
title: fetch
description: How wplace.live's window.fetch is wrapped by SvelteKit and Pawtect, what a mod's own fetch wrapper sees, and what Pawtect logs.
tags: [source/caelestis, pawtect/visible]
symbol:
  kind: function
  name: fetch
  signature: "window.fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>"
  parameters:
    - { name: input, type: "RequestInfo | URL", description: "Wplace passes strings for its API, and MapLibre passes `Request` objects for tiles. Read the URL without calling user-controlled `toString`." }
    - { name: init, type: "RequestInit", optional: true, description: "Read `method` once, before calling through. Native `fetch` consumes it." }
  returns: { type: "Promise<Response>", description: "Hand back the same `Response` object, or one that behaves identically." }
  source: https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/page-requests.ts
---

**Pawtect:** visible, and flag risk. Pawtect wraps `window.fetch` and logs every absolute URL fetched through it, up to 64, into the next token. Patching `json` or `text` on a backend API response sets **Tampered response**. Wrapping `fetch` itself sets no flag.

Wplace's API calls to `https://backend.wplace.live` and MapLibre's tile and style requests all go through `window.fetch`. A wrapper on it sees them, with their responses. Module imports, images, and the [notification stream](Live-notifications) do not use `fetch`.

## The wrapper chain

On 26 November 2026, `window.fetch` changed twice during load:

1. ~100–160 ms: SvelteKit's hydration wrapper.
2. ~200–510 ms: Pawtect's wrapper. It captures the current `window.fetch` and replaces it with a doubly bound function. Its `name` is `"bound bound "` and `String(fetch)` reads `function () { [native code] }`.

Pawtect's wrapper calls whatever `window.fetch` was when it loaded. So the order decides what each layer sees:

| You install | Your wrapper sits | You see |
| --- | --- | --- |
| At document start | Beneath Pawtect | Every page request, after Pawtect has logged it |
| After Pawtect loads | Above Pawtect | Every page request, before Pawtect logs it |

Other mods also wrap `fetch` at document start, and one installed after yours ends up above it. Caelestis moves its wrapper to the outside once, on the first request, so a mod that replaces `Response` objects from outside cannot hide tiles from it ([`page-requests.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/page-requests.ts)).

## Observing without changing anything

```ts
const native = window.fetch
window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
  const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0])
  const pending = native.apply(this, args)
  pending.then((response) => {
    if (new URL(url, location.href).pathname.startsWith('/files/')) onTile(url, response.clone())
  }, () => {})
  return pending
}
```

- Return the original promise, or a promise of the original `Response`. A new `Response` loses `url`, `redirected` and `type`.
- Read bodies from `response.clone()`.
- Never add own `json` or `text` properties to a response from Wplace's API client. Pawtect checks every API response for them. Tile responses are not checked, and Caelestis shadows `arrayBuffer` and `blob` on tile responses only ([Watching tiles](Watching-tiles)).
## Your mod's own requests

A request your mod sends through `window.fetch` after Pawtect loads is logged like any other. Its host appears in your users' next paint token. Wplace's server can see which mods its players run. Send your own requests through the current `window.fetch`, not a reference saved before Pawtect loaded, and don't try to keep them out of the log ([Anti-cheat](Anti-cheat)).

## What goes through it

| Host | What | Notes |
| --- | --- | --- |
| `backend.wplace.live` | API: `/me`, `/paint`, `/map/hotspots`, and the rest | Counts toward the API [rate limit](Rate-limits). Checked for tampered responses. |
| `backend.wplace.live/files/` | Map tiles | Answered by the [service worker](Service-worker-messages) first. Own rate limit. |
| `maps.wplace.live` | Basemap style, vector tiles, sprites, glyphs | |

## Related

- [Watching tiles](Watching-tiles)
- [Pawtect safety](Pawtect-safety)
- [Page load timeline](Page-load-timeline)
