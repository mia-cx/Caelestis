---
title: Layers versus tile compositing
description: Why a template drawn in its own MapLibre layer beats rewriting Wplace's tile PNGs, with measured costs and the layer built end to end.
tags: [source/caelestis, source/client, pawtect/none]
---

**Pawtect:** none. A layer reads no response and changes none. Rewriting tile responses sets no flag either: Pawtect checks only API responses for tampering ([Anti-cheat](Anti-cheat)). The difference between the two approaches is cost, not risk.

A template overlay can reach the screen two ways. This page compares them with numbers [Caelestis](https://github.com/mia-cx/Caelestis) measured, then builds the layer approach step by step. Checked against the live client on 26 November 2026 (MapLibre 5.21.1), except where a finding is dated otherwise.

## The two approaches

**Tile compositing.** The mod wraps `fetch`. For each tile PNG, it decodes the image, draws the template into it, encodes a new PNG, and hands Wplace a new `Response`. Wplace then draws the modified tile as if the server had sent it. Blue Marble and Skirk work this way. Blue Marble also upscales each tile 3× so a template pixel can be drawn smaller than a canvas pixel.

**A layer.** The mod adds its own layer to Wplace's MapLibre map. MapLibre calls it inside each frame, with the map's own WebGL context. The tiles stay untouched, and the template is a separate texture drawn on top of them. Caelestis works this way ([`gl/`](https://github.com/mia-cx/Caelestis/tree/main/apps/userscript/src/gl)).

## What tile compositing costs

| Cost | Why | Measured |
| --- | --- | --- |
| Main-thread work per tile | Decode the PNG, draw, read the pixels back, encode a PNG. All of it runs on the page's thread. | A tile is 1000 × 1000: 4 MB of RGBA. Upscaled 3×, it is a 3000 × 3000 canvas and a 36 MB `getImageData` per tile. |
| Latency | Wplace cannot decode a tile until the rewritten response resolves. | Caelestis once read tiles back inside Wplace's `createImageBitmap` promise. Wplace could not draw a tile until the read finished ([#729](https://github.com/mia-cx/Caelestis/issues/729)). It moved the work to a worker, after Wplace has its bitmap. |
| Work repeated on every refresh | Wplace re-downloads every visible tile on a timer, changed or not ([Wplace's renderer](Map-rendering)). The composite runs again for each one. | 20 tile downloads, 4,048 KB, per idle minute over Paris (24 September 2026). Tiles there were 200–455 KB each. |
| Re-downloads on every template change | The template is baked into the tile. Moving it, hiding it or changing its opacity needs the tiles again. `map.refreshTiles` re-downloads every visible tile. | 20–50 tile requests per change at a normal view ([#724](https://github.com/mia-cx/Caelestis/issues/724)). The tile [rate limit](Rate-limits) blocks an IP address at about 28.5 requests per second, so dragging a template trips it within seconds. |
| Cache churn | Tiles are served `no-store`, so every refresh goes to the network. A full refresh also resets MapLibre's off-screen tile cache. | A 3× tile is a 36 MB texture on the GPU, against 4 MB for a plain one. |
| Bigger tiles | A re-encoded PNG is rarely as small as Wplace's indexed one. | Wplace's own service worker composites drafts this way. A tile it re-encoded was 1.59 MB, against 218 KB from the server. |
| Other mods | A rewritten tile is what every other reader sees. | Caelestis received Blue Marble's 3× tiles with Blue Marble's template drawn in. It now fetches its own copies in a worker, where no page script can rewrite them ([#712](https://github.com/mia-cx/Caelestis/pull/712)). |
| Wrapper order | Two mods that both wrap `fetch` and replace responses break each other, depending on which installs first. | With Blue Marble's wrapper outside Caelestis's, Caelestis saw no tile bytes at all ([#776](https://github.com/mia-cx/Caelestis/pull/776)). |

**The Pawtect angle.** Pawtect wraps `window.fetch` after its WebAssembly loads, so it sits outside every wrapper a mod installs at document start. It logs the URLs fetched through it. It flags a response from Wplace's API client whose `json` or `text` was replaced. Tile responses never pass through that check, so a rewritten tile sets no flag today. A layer avoids the question: it never touches a response.

## How the layer approach works

### 1. Get the map

Catch the MapLibre map as it is built ([Finding the map](Finding-the-map)). Everything below needs it.

### 2. Add a custom layer

```ts
map.addLayer(
  {
    id: 'my-template',
    type: 'custom',
    renderingMode: '2d',
    onAdd(_map, gl: WebGL2RenderingContext) { setUp(gl) },
    render(gl: WebGL2RenderingContext, options) { draw(gl, options.modelViewProjectionMatrix) },
  },
  'pixel-hover',
)
```

The context is WebGL2. MapLibre resets its own cached GL state before and after a custom layer, so set every piece of state your draw needs, every time. Don't read state back with `getParameter`: it stalls the CPU behind the GPU.

A throw from `render` takes the whole frame with it. MapLibre then stops rendering, and the map freezes on its last frame while the page still looks alive. Catch everything inside `render`.

### 3. Upload the template once

Upload the template as palette indices, one byte per pixel, in an integer texture. Do it once, not per frame.

```ts
const uploadIndices = (gl: WebGL2RenderingContext, width: number, height: number, indices: Uint8Array) => {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, indices)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  return texture
}
```

The colours live in a 64-entry uniform, so recolouring or hiding one colour costs nothing. Indices follow Wplace's [palette](Palette).

```glsl
#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D u_indices;
uniform vec4 u_palette[64]; // premultiplied RGBA; Transparent is vec4(0)
in vec2 v_texel;            // template pixel coordinates
out vec4 colour;
void main() {
  uint index = texelFetch(u_indices, ivec2(v_texel), 0).r;
  colour = u_palette[int(index)];
}
```

Draw with `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`. Split templates larger than `MAX_TEXTURE_SIZE` into chunks.

A large upload stalls the frame it runs in. Caelestis uploads at most 512K pixels per frame, draws each chunk as soon as it is ready, and keeps 64 MiB of template textures before it evicts off-screen ones. Before it drew chunks early, a 36-megapixel template took about 70 frames to appear ([#730](https://github.com/mia-cx/Caelestis/issues/730)).

### 4. Land on Wplace's pixels

Wplace's tiles are Web Mercator tiles at zoom 11 ([Coordinates](Coordinates)). A world pixel's Mercator coordinate is just its position divided by the world size, with no trigonometry:

```ts
const WORLD_PIXELS = 2048 * 1000
const mercator = (px: number, py: number): [number, number] => [px / WORLD_PIXELS, py / WORLD_PIXELS]
```

With `options.modelViewProjectionMatrix`, those coordinates land close to Wplace's art, but not on it. Two things move them:

- **Rounding.** While the map stands still, MapLibre snaps each tile's position to whole device pixels. While it moves, it does not. A layer placed by projection agrees during a pan and drifts the moment the map settles. Measured at zoom 12.37: the snapped tile corner sat 0.30 px left of and 0.47 px above `map.project()` of the same corner. The gap shows as a one-pixel seam wherever Wplace's art shows through.
- **Precision.** In 32-bit floats, a Mercator coordinate near the middle of the world resolves about an eighth of a Wplace pixel. Deep zooms show it as jitter.

The exact fix is to draw with the matrices MapLibre draws Wplace's tiles with. They are MapLibre-private, so keep the projection as a fallback:

```ts
interface TileId { canonical: { x: number; y: number } }
interface MapInternals {
  style?: { tileManagers?: unknown }
  painter?: {
    options?: { moving?: boolean }
    transform?: { calculatePosMatrix(id: TileId, aligned: boolean, asFloat32: boolean): Float32Array }
  }
}
type TileManager = { getVisibleCoordinates(): TileId[] }

/** Wplace's tiles in this frame, each with the matrix MapLibre draws it with. Null if the internals moved. */
const wplaceTiles = (map: MapInternals) => {
  const managers = map.style?.tileManagers as { get?(id: string): TileManager } & Record<string, TileManager>
  const manager = typeof managers?.get === 'function' ? managers.get('pixel-art-layer') : managers?.['pixel-art-layer']
  const transform = map.painter?.transform
  if (!manager || typeof transform?.calculatePosMatrix !== 'function') return null
  const aligned = map.painter?.options?.moving !== true
  return manager.getVisibleCoordinates().map((id) => ({
    x: id.canonical.x,
    y: id.canonical.y,
    matrix: transform.calculatePosMatrix(id, aligned, true),
  }))
}
```

Each matrix maps tile units, 0 to 8192 across one tile, to clip space. Draw one quad per tile the template covers. A template pixel at world `(px, py)` on tile `(x, y)` sits at `((px - x * 1000) * 8.192, (py - y * 1000) * 8.192)` in tile units. The tile list is also your culling: MapLibre only lists tiles in view.

Caelestis also reads these matrices out of MapLibre's own draw calls, as a cross-check ([getContext](WebGL-context)). Wplace keeps pitch at 0, but the keyboard can rotate the world map ([Keyboard input](Keyboard-input)), so the matrices can carry a bearing. Matrices from MapLibre's own tile draws already include it.

### 5. Stay in the right place in the stack

Where your layer sits decides what covers it. Caelestis keeps this order, bottom to top ([`layer-stack.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/gl/layer-stack.ts)):

| Layer | Why there |
| --- | --- |
| An outline of the template | Below `pixel-art-layer`, so painted pixels cover it. What still shows is unpainted. This is a painted-or-not test done by layer order, with no pixel read. |
| `pixel-art-layer` | Wplace's tiles |
| The template | Above the art |
| Wplace's `paint-preview-` draft layers | So a pixel the player places covers the template |
| Markers | Above drafts, because a marker annotates a pixel |
| `pixel-hover` | Wplace's crosshair stays on top |

Wplace adds a draft layer per tile while the player paints, above yours. Check the order and move your layers only when it is wrong. Check on each frame that draws tiles, not on `styledata`. Wplace moves its own highlight layers on `styledata`, so a mod that also moves layers there starts a loop that runs for the life of the tab ([Wplace's renderer](Map-rendering)).

### 6. Survive a theme switch

A theme switch calls `map.setStyle` with a style transform that carries Wplace's own sources and layers into the new basemap ([Theme](Theme)). Measured on 26 November 2026, switching both ways: a custom layer, and an image source with its raster layer, both stayed, in order, above `pixel-art-layer`.

That is MapLibre diffing the two styles, not a promise. MapLibre falls back to a full reload when it cannot diff a style, and a full reload drops everything you added. Caelestis's code also guards against a kept layer ending up below `pixel-art-layer`. So on every `style.load`, add what is missing and move what is out of order ([Drawing overlays](Drawing-overlays)).

### 7. Repaint when something changes

MapLibre renders on demand. Call `map.triggerRepaint()` when your template, its colours or its visibility change. A fade, or a texture upload spread over several frames, has to ask for each next frame itself.

Repaint when tiles change too. A refreshed tile can change your progress counts or markers, but it does not change where the template draws.

### 8. Stop where Wplace stops

The tile source has `minzoom` 11, so MapLibre draws no Wplace tiles further out. Stop drawing there too, or your template floats over a map that no longer shows the art it annotates.

## Why not a canvas on top

A mod can also stack its own `<canvas>` over the map and draw there. Caelestis started that way in August 2026. It has two problems a layer doesn't:

- It cannot go under Wplace's crosshair or the player's drafts. It covers everything.
- It lags. MapLibre renders inside its own animation frame, so a `requestAnimationFrame` scheduled from there draws one frame late. Over a real drag, 37 of 57 frames were late. Drawing from a microtask queued during MapLibre's frame put all 57 on time.

## What the layer still needs from tiles

Drawing needs no tile data. Progress counts and wrong-pixel markers do: they compare the template with what is painted. Read the tiles; never modify them.

- **Read what Wplace downloads.** Tag or clone each tile body as Wplace reads it ([Watching tiles](Watching-tiles)). Don't fetch tiles a second time: that doubles your users' tile traffic against one rate limit.
- **Read after Wplace has its bitmap.** Decode, read back and match colours in a worker, so Wplace's tile is never waiting on you. Before Caelestis moved its reads to a worker, a painter's 250-second profile of a long draft session put 63.4% of Caelestis's main-thread time in tile reads ([#279](https://github.com/mia-cx/Caelestis/issues/279)).
- **Skip unchanged bytes.** Most refreshes return the same tile. Hash the body, and skip the read when the hash matches.
- **Map colours by RGB.** A tile PNG's palette is its own, and its indices are not Wplace's colour ids ([Palette](Palette)).
- **Expect sparse and missing tiles.** Sparse tiles come as 1-, 2- or 4-bit PNGs. A tile with no paint answers `404`, or a 1 × 1 transparent PNG through Wplace's service worker.
- **Add the drafts.** What the player has placed but not sent lives on the [draft canvases](Draft-canvases), not in the tiles.
- **Keep accepted paint until a tile shows it.** After an accepted paint, the next tile download can still predate it. Keep the accepted pixels until a newer tile shows them ([Reading the paint UI](Reading-the-paint-UI)).

## Trade-offs

| | Layer | Tile compositing |
| --- | --- | --- |
| Cost per template change | A repaint, no requests | Every visible tile re-downloaded and re-composited |
| Cost per refresh | None for drawing | One composite per visible tile |
| Per-colour or per-template views | A uniform change | A full re-composite |
| Other mods' tiles | Untouched | Rewritten |
| What it depends on | The map handle; private MapLibre internals for exact alignment | Only `fetch` and a canvas |
| Code | More: shaders, layer order, style changes, context loss | Less |
| Wplace's colour picker | Sees the template, because the picker reads the rendered map | Sees the template |

From Caelestis's reading of the client: Wplace's world colour picker reads the rendered map, so it picks up anything drawn there, from either approach. Caelestis draws the picked cell solid in the template colour for the frame Wplace reads it ([`wplace-picker.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-picker.ts)).

## GPU and driver quirks

A layer shares Wplace's WebGL context, so GL state it leaves behind can corrupt MapLibre's next draw, and the reverse.

One open case, from Caelestis's research on 25 November 2026 ([#898](https://github.com/mia-cx/Caelestis/issues/898)): on an HP Chromebook (Intel UHD Graphics 600, Mesa 24.2.3, ANGLE on OpenGL ES, Chrome 158), the map flashed green and showed rectangular checkerboards for single frames. It needed three things at once: Caelestis, a visible template and a large unsent draft, probably with the camera moving. With templates hidden it ran cleanly. The suspects are integer textures (`R8UI` with `usampler2D`), which some GLES drivers handle badly, and a template pass sampling a texture unit Wplace's draft or crosshair texture is bound to. Chrome's driver workarounds on that device restart the GPU process on context loss instead of recovering. The cause is not confirmed.

Low-power GPUs also run hot under a heavy fragment shader. Caelestis's template shader samples up to 16 template pixels per screen pixel when zoomed out. Keep zoomed-out sampling cheap.

## Related

- [Drawing overlays](Drawing-overlays)
- [Wplace's renderer](Map-rendering)
- [Watching tiles](Watching-tiles)
- [Palette](Palette)
- [Map sources and layers](Map-sources-and-layers)
- [getContext](WebGL-context)
