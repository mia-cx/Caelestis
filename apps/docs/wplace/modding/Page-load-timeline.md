---
title: Page load timeline
description: When each Wplace hook point appears during page load, measured in milliseconds after document start on the live client.
order: 3
tags: [source/caelestis, source/client, pawtect/visible]
---

**Pawtect:** visible. Pawtect's `fetch` wrapper goes in a few hundred milliseconds after document start. A `fetch` wrapper you install before it sits beneath it; one you install after sits above it. See [fetch](Page-fetch).

Measured on 26 November 2026 by loading `https://wplace.live/?lat=52.52&lng=13.40&zoom=14` in Chromium 156 with a fresh profile, signed out, over three loads. A probe at document start recorded each event. Times are rounded and vary with network and machine; the order did not vary.

| ms after document start | Event | Hook it enables |
| --- | --- | --- |
| 0 | Your document-start script runs. `document.readyState` is `loading`. | Wrap browser APIs now |
| ~100–160 | `DOMContentLoaded` and `load` fire. The page is prerendered, so Wplace's app has not started. | DOM of the prerendered shell only |
| ~100–160 | SvelteKit replaces `window.fetch` with its hydration wrapper. | — |
| ~140–200 | Wplace's state object is constructed. | [WplaceState](Wplace-state) |
| ~170–480 | A WebGL context is created on a detached 300 × 150 canvas. It is not the map. Best guess: the bot check, which reads the WebGL vendor and renderer. | — |
| ~240–340 | The MapLibre `Map` is constructed. | [map](Map) |
| ~200–510 | Pawtect loads its WebAssembly and wraps `window.fetch`. | [fetch](Page-fetch) |
| ~280–480 | `canvas.maplibregl-canvas` enters the DOM, and MapLibre calls `getContext('webgl2')` on it. | [getContext](WebGL-context), [Importing Wplace's modules](Importing-Wplace-modules) |
| ~580 | The map fires `style.load`. Sources and layers exist. | [Map sources and layers](Map-sources-and-layers) |
| ~600–930 | Dozens of small detached 2D canvases are created. Best guess: map icons. | — |
| ~3400 | The map fires `load`, after its first tiles arrive. | [Watching tiles](Watching-tiles) |
| ~5200, then every 5 s | The page posts `clearPixelPreview` to its service worker. | [ServiceWorkerMessage](Service-worker-messages) |

The paint drawer and its palette appear only when a signed-in player opens Paint. See [Reading the paint UI](Reading-the-paint-UI).

## Rules of thumb

- Wrap browser APIs at document start, synchronously. A microtask is still early enough. A `setTimeout` is not.
- Don't use `DOMContentLoaded` as "Wplace is ready". Wait for the map canvas, or for the map's `style.load`.
- Don't evaluate Wplace's own modules before its map canvas exists. A module that throws during evaluation stays broken for the page, and Wplace's own import of it then fails ([Importing Wplace's modules](Importing-Wplace-modules)).
- Single-page navigation can replace the map. Watch for its canvas leaving the document, and find the new one.
