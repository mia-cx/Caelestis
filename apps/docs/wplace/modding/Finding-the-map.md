---
title: Finding the map
description: Get the MapLibre map instance the page renders with, from page context, by catching it while it is constructed.
order: 4
tags: [source/caelestis, pawtect/none]
---

**Pawtect:** none. The trap below touches `Object.prototype` for a few hundred milliseconds and adds no global. Pawtect does not check either.

Wplace never exposes its [map](Map). You catch it while it is built, from a script that runs in the page at document start ([Getting into page context](Getting-into-page-context)).

## Catch it in the constructor

MapLibre's `Map` constructor runs `this._canvasContainer = …`. If `Object.prototype` has a setter for `_canvasContainer`, that assignment calls the setter with `this` set to the map. The setter must then create the property itself, exactly as a plain assignment would, or MapLibre breaks.

```ts
type MapLike = { flyTo: (options: object) => unknown; getZoom: () => number; on: (type: string, listener: () => void) => unknown }

const WITNESS = '_canvasContainer'

export const catchMap = (onMap: (map: MapLike) => void): void => {
  Object.defineProperty(Object.prototype, WITNESS, {
    configurable: true,
    get: () => undefined,
    set(this: object, value: unknown) {
      // Finish the assignment the constructor started.
      Object.defineProperty(this, WITNESS, { value, writable: true, configurable: true, enumerable: true })
      const candidate = this as Partial<MapLike>
      if (typeof candidate.flyTo !== 'function' || typeof candidate.getZoom !== 'function') return
      Reflect.deleteProperty(Object.prototype, WITNESS)
      // The constructor is still running. Use the map after it returns.
      queueMicrotask(() => onMap(candidate as MapLike))
    },
  })
}
```

Rules for this trap:

- Install it at document start, before Wplace's modules evaluate. A later install never fires.
- Install it on the page's `Object.prototype`. From a userscript sandbox that is `unsafeWindow.Object.prototype`.
- Check the shape before you claim an object. Other code assigns `_canvasContainer` too.
- Remove it as soon as it fires. Every object in the page inherits it while it is there.
- Never throw from the setter. It runs inside MapLibre's constructor.
- If another script already defined `_canvasContainer` on `Object.prototype`, leave it alone. Caelestis also tries `_controlContainer` and `_canvas`, which MapLibre assigns in the same step ([`map-handle.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/map-handle.ts)).

Confirmed on 26 November 2026: the trap fires once, about 250 ms after document start, and the caught object's canvas is `canvas.maplibregl-canvas`.

## Or read it from Wplace's state

Wplace's app-wide state object has a `map` property that holds the same instance. If your mod already catches [WplaceState](Wplace-state), read `state.map` once the canvas exists. This path depends on Wplace's private state, not MapLibre's internals.

## When the map is replaced

Single-page navigation can unmount the map and build a new one. Watch the caught map's canvas. When it leaves the document, drop your reference and catch the next one: install the trap again, or read `state.map` again.

```ts
const watchDetach = (map: MapLike & { getCanvas(): HTMLCanvasElement }, onGone: () => void) => {
  const canvas = map.getCanvas()
  const observer = new MutationObserver(() => {
    if (canvas.isConnected) return
    observer.disconnect()
    onGone()
  })
  observer.observe(document, { childList: true, subtree: true })
}
```

## Without the map

If both paths fail, a mod can still read the camera from the [URL parameters](URL-parameters) Wplace loaded with, and the canvas from the DOM (`canvas.maplibregl-canvas`). Moving the camera then means changing the URL, which reloads the page.

## Related

- [map](Map)
- [Page load timeline](Page-load-timeline)
- [Drawing overlays](Drawing-overlays)
