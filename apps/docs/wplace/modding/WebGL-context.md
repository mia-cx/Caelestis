---
title: getContext
description: Reach the map's WebGL2 context by wrapping HTMLCanvasElement.prototype.getContext, and tell it apart from Wplace's other canvases.
tags: [source/caelestis, pawtect/none]
symbol:
  kind: function
  name: HTMLCanvasElement.prototype.getContext
  signature: "getContext(contextId: 'webgl2', options?: WebGLContextAttributes): WebGL2RenderingContext | null"
  parameters:
    - { name: contextId, type: "string", description: "MapLibre asks for `\"webgl2\"` on `canvas.maplibregl-canvas`. Other callers ask for `\"webgl\"` and `\"2d\"`." }
    - { name: options, type: "WebGLContextAttributes", optional: true }
  returns: { type: "WebGL2RenderingContext | null", description: "Return the native context unchanged. Wrap its methods, not the object." }
  source: https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/gl-observer.ts
---

**Pawtect:** none. Pawtect's bot check reads the WebGL vendor and renderer from its own detached canvas. It does not inspect the map's context or `getContext` itself.

MapLibre creates its WebGL2 context when it builds the map, about 300–400 ms after document start. A wrapper on `HTMLCanvasElement.prototype.getContext`, installed at document start, sees that call and gets the context. With the context, you can watch every draw call the map makes.

You rarely need this. A [custom layer](Drawing-overlays) gets the same context from MapLibre in `onAdd`, with no wrapping. Wrap `getContext` only when you need to see what MapLibre draws.

## Which canvas is the map's

On 26 November 2026, a fresh load made these calls:

| Canvas | Context | What |
| --- | --- | --- |
| Detached, 300 × 150 | `webgl` | A one-off probe. Best guess: the bot check. |
| `canvas.maplibregl-canvas`, in the DOM | `webgl2` | The map |
| Detached, 44 × 44 and smaller | `2d` | Best guess: map icons |

The probe came first on some loads and after the map on others, so the first WebGL context is not always the map's. Check for the `maplibregl-canvas` class, or compare with `map.getCanvas()` once you have the [map](Map).

```ts
const nativeGetContext = HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof nativeGetContext>) {
  const context = nativeGetContext.apply(this, args)
  if (args[0] === 'webgl2' && context !== null && this.classList.contains('maplibregl-canvas')) onMapContext(context as WebGL2RenderingContext)
  return context
} as typeof nativeGetContext
```

## What the context tells you

Caelestis wraps these methods on the map's context to learn where each tile was drawn ([`gl-observer.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/gl-observer.ts)):

- `getUniformLocation`: maps uniform names, such as `u_projection_matrix`, to locations.
- `uniformMatrix4fv`: the matrix for the next draw.
- `useProgram`, `bindTexture`: which shader and texture the draw uses.
- `texImage2D`, `texSubImage2D`: which bitmap went into which texture. MapLibre reuses textures, so a refreshed tile arrives through `texSubImage2D`.
- `drawElements`, `drawArrays`: the draw itself.

Each wrapper calls the native method first and returns its result unchanged. A wrapper that throws, or changes a result, breaks the map for everyone.

## Stability

- Shader uniform names come from MapLibre and change only with MapLibre's shaders.
- The map can lose its context (`webglcontextlost`) and get a new canvas on navigation. Follow the canvas, not the first context you saw.
- WebGL in a headless or virtual-display browser may be unavailable. Wplace then shows `h1#map-unsupported-title` and never builds a working map.

## Related

- [Drawing overlays](Drawing-overlays)
- [Watching tiles](Watching-tiles)
- [Draft canvases](Draft-canvases)
