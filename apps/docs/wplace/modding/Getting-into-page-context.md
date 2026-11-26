---
title: Getting into page context
description: Run a userscript or extension in wplace.live's own JavaScript world at document start, where Wplace's map, state and fetch are reachable.
order: 2
tags: [source/caelestis, pawtect/none]
---

**Pawtect:** none. Where your script runs is invisible to Pawtect. What it does there may not be: see [Pawtect safety](Pawtect-safety).

Wplace keeps its map, its state and its requests inside module closures. Nothing hangs on `window`. To reach them, your code has to run in the page's own JavaScript world, and most hooks also need it to run before Wplace's modules evaluate.

## The two worlds

| World | Who runs there | Sees Wplace's objects |
| --- | --- | --- |
| Page (main) world | Wplace's scripts, `<script>` tags, MV3 scripts with `world: "MAIN"`, userscripts with `@grant none` in most managers | Yes |
| Isolated world | Default extension content scripts, userscripts with `@grant` in most managers | No. It shares the DOM, but has its own `window`, `fetch`, `Object.prototype` and `WeakMap` |

A hook installed in an isolated world patches objects Wplace never calls. It fails silently: no error, and nothing captured. Separate worlds also have separate constructors, so `value instanceof Blob` is false for a page `Blob` seen from the isolated world. Compare with the page's constructor, or check the shape.

## Browser extension (Manifest V3)

Declare a content script in the main world at document start. Chromium 111 and Firefox 128 support `world: "MAIN"`.

```json
{
  "content_scripts": [
    { "matches": ["https://wplace.live/*"], "js": ["bridge.js"], "run_at": "document_start" },
    { "matches": ["https://wplace.live/*"], "js": ["page.js"], "run_at": "document_start", "world": "MAIN" }
  ]
}
```

`chrome.*` APIs exist only in the isolated script. Pass data between the two over `window.postMessage` or a `MessagePort`. Anything you post on `window` is readable by Wplace's scripts too. Caelestis lists its isolated script first, hands the page script a `MessagePort` in one `window` message, and stops that event before page listeners see it ([`storage-bridge/protocol.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/storage-bridge/protocol.ts)).

## Userscript

Use `@run-at document-start`. With `@grant none`, most managers run the script in the page. With any `@grant`, many managers run it in a sandbox. There you have two options:

- Patch through `unsafeWindow`, the page's global. Use the page's own constructors (`unsafeWindow.Object`, `unsafeWindow.WeakMap`), not the sandbox's.
- Inject your code into the page as a `<script>` element. It runs synchronously when appended, before the parser reaches Wplace's scripts.

```ts
// From the manager's sandbox, at document-start.
const script = document.createElement('script')
script.textContent = `(${pageMain})()`
;(document.head ?? document.documentElement).append(script)
script.remove()
```

`@run-at document-start` asks for early injection, but managers don't promise to run before the page's own scripts. From Caelestis's reports in November 2026 ([#887](https://github.com/mia-cx/Caelestis/issues/887)):

- A painter on a slow laptop with Tampermonkey on Chrome got Caelestis's template on only about 1 load in 7. On the others, the script ran after Wplace had built its map, and both the map trap and the `getContext` wrapper missed.
- Violentmonkey 2.50 on Manifest V3 also injected late.
- 36 reloads with Tampermonkey 5.5.0 on Chromium 150 on a fast Mac all ran in time.
- A browser extension's `document_start` content script in the main world did not race.

So plan for a late start: find an existing map and canvas instead of only catching them as they are built. `document.querySelector('canvas.maplibregl-canvas')` finds the canvas. Calling `getContext('webgl2')` on it again returns the map's existing context.

At document start `<html>` may not exist yet. Append to `document.documentElement`, or to `document` itself. wplace.live sent no `Content-Security-Policy` header on 26 November 2026, so inline scripts run. Check that a script ran before relying on it: Caelestis sets an attribute on `document.currentScript` from inside the injected copy ([`entry.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/entry.ts)).

## Timing

Install anything that wraps a browser API (`fetch`, `getContext`, `Blob`, `WeakMap.prototype.set`, `Object.prototype` setters) synchronously at document start. Wplace's state object is built about 150 ms after document start and its map about 250 ms after. [Page load timeline](Page-load-timeline) has the full order.

Hooks that only read the DOM or call the map's public methods can start later. Wait for the map canvas, not `DOMContentLoaded`: the page is prerendered, so `DOMContentLoaded` and `load` fire before Wplace's app has started.

## Related

- [Finding the map](Finding-the-map)
- [Page load timeline](Page-load-timeline)
- [Globals and page events](Globals-and-page-events)
