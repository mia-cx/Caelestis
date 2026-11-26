---
title: Importing Wplace's modules
description: Find Wplace's content-hashed ES modules by what their source contains, and import them safely once the app has booted.
order: 9
tags: [source/caelestis, pawtect/visible]
---

**Pawtect:** visible. Reading module sources with `fetch` after Pawtect loads puts their `https://wplace.live/_app/…` URLs in Pawtect's log. That sets no flag. `import()` does not go through `fetch` and is not logged.

Wplace is a SvelteKit app built with Vite. Its code ships as about 500 ES modules under `/_app/immutable/`:

| Path | What |
| --- | --- |
| `/_app/immutable/entry/start.{hash}.js`, `app.{hash}.js` | SvelteKit's entry points |
| `/_app/immutable/nodes/{n}.{hash}.js` | One per route layout or page |
| `/_app/immutable/chunks/{hash}.js` | Shared code: MapLibre, Pawtect, the locale catalogs, components |

File names are content hashes. They change whenever the code inside changes, so never hard-code one. On 26 November 2026, the chunk holding MapLibre kept its name from 20 November, and the chunk holding Pawtect's loader changed name.

## Finding a module by its source

1. List the modules the page knows about: `link[rel="modulepreload"]` elements (about 100 on the home page), and `performance.getEntriesByType('resource')` for those loaded since.
2. Fetch each one's source with `cache: 'force-cache'`. That reuses the browser's cached copy when there is one; a module the page never loaded still costs a network request.
3. Follow the relative imports in each source, `"./X.js"` and `"../chunks/X.js"`.
4. Pick the module whose source contains a string unique to it: a message, an error text, a storage key.
5. `import()` the same URL. The browser returns the instance Wplace already uses.

Caelestis does this to find the [message catalog](Message-catalog) ([`wplace-modules.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-modules.ts)).

## Wait for the map

Don't import a Wplace module before the app has booted. Many modules read the message catalog when they evaluate, and the catalog only exists once Wplace's startup has loaded the locale. A module that throws during evaluation stays failed for the life of the page, and then Wplace's own import of it fails too: the map never appears.

`DOMContentLoaded` is too early. Wait for `canvas.maplibregl-canvas` to be in the document. Wplace builds its map only after its startup finished.

```ts
const whenMapCanvas = () =>
  new Promise<void>((resolve) => {
    const ready = () => document.querySelector('canvas.maplibregl-canvas')?.isConnected === true
    if (ready()) return resolve()
    const observer = new MutationObserver(() => {
      if (!ready()) return
      observer.disconnect()
      resolve()
    })
    observer.observe(document, { childList: true, subtree: true })
  })
```

If the canvas never appears, don't import anything.

## Stability

Exports are minified: a module exports `a`, `t`, `n` and so on, and the letters change between builds. Pick an export by what it does, for example by a string in `Function.prototype.toString`, not by its name.

## Related

- [Page load timeline](Page-load-timeline)
- [Getting into page context](Getting-into-page-context)
- [Globals and page events](Globals-and-page-events)
