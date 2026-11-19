import { TILE_SIZE, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { registerDebugEntry } from '../console-api.js'
import type { TileQuad } from '../coordinates.js'
import { log, warn } from '../debug.js'
import type { PixelRect } from '../geometry.js'
import { getMap } from '../map-handle.js'
import { redraw, requestMapFrame } from '../map-view.js'
import { overlayPeekFade } from '../overlay-peek.js'
import {
  clearGpuProfile,
  isProfileEnabled,
  measureProfile,
  profileGpu,
  recordProfileWorkload,
  registerProfileMemorySource,
} from '../profile.js'
import {
  displayTemplatesForSurface,
  noteTemplatesInView,
  type PlacedTemplate,
} from '../templates/local-store.js'
import { type HorizontalSpan, horizontalSpans } from '../templates/placement.js'
import { currentQuads, isDrawingTiles, underlayQuads } from '../tile-frame.js'
import { prefersReducedMotion } from './appearance-transition.js'
import { LAYER_IDS } from './layer-stack.js'
import { movingOverlayTapCap } from './minify-quality.js'
import { worldRenderScene } from './render-scene.js'
import { writeQuad } from './renderer-core.js'
import {
  TEMPLATE_UPLOAD_PIXELS_PER_FRAME,
  type TemplateGpuEntry,
  TemplateGpuStore,
  type TemplateGpuTile,
} from './template-gpu-store.js'
import { SETTLED_TAP_CAP, TemplatePass, type TemplatePlacement } from './template-pass.js'

/**
 * The overlay, drawn inside Wplace's own canvas.
 *
 * A MapLibre custom layer inserted before `pixel-hover`, which is the layer their selected-pixel
 * marker lives in. Being *in* their layer stack is what puts our templates under their crosshair and
 * under any pixels waiting to be placed, rather than on a canvas stacked over the lot.
 *
 * It also removes an entire class of bug rather than fixing it. Every seam, drift and half-pixel
 * fringe came from rasterising into our own screen-space canvas and then trying to make that grid
 * agree with theirs. Here there is one grid, and we do not re-derive it.
 *
 * **Positions come from their tiles, not from a projection of our own.** One quad per Wplace tile a
 * template covers, placed on the on-screen rect that tile was actually drawn at this frame. Nothing
 * here projects anything, which is what keeps our pixel grid on theirs: MapLibre snaps raster tiles
 * to whole device pixels once the map stops moving and does not snap while it moves, so an overlay
 * that projects independently agrees during a pan and disagrees by a fraction of a pixel the moment
 * it settles. That fraction is a one-device-pixel seam wherever their canvas shows through.
 *
 * Tiling is also the culling: Wplace only draws the tiles in view, so intersecting a template
 * against them is the entire visibility test.
 */

const NOTHING_IN_VIEW: ReadonlySet<string> = new Set()

/**
 * A debug nudge, in canvas pixels, applied to every template's extent.
 *
 * Set from the console with `__caelestis.nudge(dx, dy)`. It exists to *measure* a suspected offset
 * between our pixel grid and Wplace's: a sub-pixel disagreement is invisible wherever the overlay
 * draws solidly and only shows at a hole where their canvas is visible underneath. Nudging until the
 * seam disappears reads the offset straight off the screen.
 */
let nudgeX = 0
let nudgeY = 0

const setNudge = (x: number, y: number): { x: number; y: number } => {
  nudgeX = x
  nudgeY = y
  return { x: nudgeX, y: nudgeY }
}

/** Whether any source pixel can reach one of the tile quads Wplace is drawing this frame. */
const intersectsTiles = (
  template: PlacedTemplate,
  spans: readonly HorizontalSpan[],
  tiles: readonly TileQuad[],
): boolean => {
  const top = template.originY + nudgeY
  const bottom = top + template.height
  return tiles.some((tile) => {
    const tileLeft = tile.tile.x * TILE_SIZE
    const tileTop = tile.tile.y * TILE_SIZE
    if (bottom <= tileTop || top >= tileTop + TILE_SIZE) return false
    return spans.some(
      (span) =>
        span.worldEnd + nudgeX > tileLeft && span.worldStart + nudgeX < tileLeft + TILE_SIZE,
    )
  })
}

/**
 * The template's parts on screen this frame, in template coordinates: Wplace's tiles, cut to the
 * drawing buffer they overhang.
 */
const visibleSourceRects = (
  template: PlacedTemplate,
  spans: readonly HorizontalSpan[],
  tiles: readonly TileQuad[],
  bufferWidth: number,
  bufferHeight: number,
): PixelRect[] => {
  const rects: PixelRect[] = []
  const top = template.originY + nudgeY
  for (const tile of tiles) {
    const scaleX = tile.width / TILE_SIZE
    const scaleY = tile.height / TILE_SIZE
    const tileLeft = tile.tile.x * TILE_SIZE
    const tileTop = tile.tile.y * TILE_SIZE
    const screenLeft = tileLeft + Math.max(0, -tile.x / scaleX)
    const screenRight = tileLeft + Math.min(TILE_SIZE, (bufferWidth - tile.x) / scaleX)
    const fromY = Math.max(top, tileTop + Math.max(0, -tile.y / scaleY))
    const toY = Math.min(
      top + template.height,
      tileTop + Math.min(TILE_SIZE, (bufferHeight - tile.y) / scaleY),
    )
    if (toY <= fromY) continue
    for (const span of spans) {
      const shift = span.sourceStart - span.worldStart - nudgeX
      const fromX = Math.max(span.worldStart + nudgeX, screenLeft)
      const toX = Math.min(span.worldEnd + nudgeX, screenRight)
      if (toX <= fromX) continue
      rects.push({ x: fromX + shift, y: fromY - top, width: toX - fromX, height: toY - fromY })
    }
  }
  return rects
}

/** Each chunk's piece on each of Wplace's tiles, in device pixels taken from their tile draws. */
const forEachTileQuad = (
  template: PlacedTemplate,
  spans: readonly HorizontalSpan[],
  entry: TemplateGpuEntry,
  tiles: readonly TileQuad[],
  bufferWidth: number,
  bufferHeight: number,
  margin: number,
  vertices: Float32Array,
  draw: (source: TemplateGpuTile) => void,
): void => {
  const templateTop = template.originY + nudgeY
  for (const source of entry.indices) {
    const halo = Math.min(margin, source.inset)
    const topMargin = source.openTop ? halo : 0
    const bottomMargin = source.openBottom ? halo : 0
    const top = templateTop + source.y - topMargin
    const bottom = templateTop + source.y + source.height + bottomMargin
    for (const span of spans) {
      // A wrapped span draws the halo only where the cell beyond the side lies in the same span.
      const leftMargin =
        source.openLeft && (span.sourceStart < source.x || span.sourceStart === 0) ? halo : 0
      const rightMargin =
        source.openRight &&
        (span.sourceEnd > source.x + source.width || span.sourceEnd === entry.width)
          ? halo
          : 0
      const sourceStart = Math.max(source.x - leftMargin, span.sourceStart - leftMargin)
      const sourceEnd = Math.min(
        source.x + source.width + rightMargin,
        span.sourceEnd + rightMargin,
      )
      if (sourceEnd <= sourceStart) continue
      const left = span.worldStart + sourceStart - span.sourceStart + nudgeX
      const right = span.worldStart + sourceEnd - span.sourceStart + nudgeX
      for (const tile of tiles) {
        const tileLeft = tile.tile.x * TILE_SIZE
        const tileTop = tile.tile.y * TILE_SIZE
        const cutLeft = Math.max(left, tileLeft)
        const cutTop = Math.max(top, tileTop)
        const cutRight = Math.min(right, tileLeft + TILE_SIZE)
        const cutBottom = Math.min(bottom, tileTop + TILE_SIZE)
        if (cutRight <= cutLeft || cutBottom <= cutTop) continue

        const scaleX = tile.width / TILE_SIZE
        const scaleY = tile.height / TILE_SIZE
        writeQuad(
          {
            left: tile.x + (cutLeft - tileLeft) * scaleX,
            top: tile.y + (cutTop - tileTop) * scaleY,
            right: tile.x + (cutRight - tileLeft) * scaleX,
            bottom: tile.y + (cutBottom - tileTop) * scaleY,
          },
          {
            u0: (source.inset + sourceStart - source.x + cutLeft - left) / source.textureWidth,
            u1: (source.inset + sourceStart - source.x + cutRight - left) / source.textureWidth,
            v0: (source.inset - topMargin + cutTop - top) / source.textureHeight,
            v1: (source.inset - topMargin + cutBottom - top) / source.textureHeight,
          },
          bufferWidth,
          bufferHeight,
          vertices,
        )
        draw(source)
      }
    }
  }
}

/**
 * Templates placed on the tiles Wplace draws this frame. Their tiles already bound what shows, so
 * a halo never widens it.
 */
const tilePlacement = (
  tiles: readonly TileQuad[],
  bufferWidth: number,
  bufferHeight: number,
): TemplatePlacement => {
  const spans = new Map<PlacedTemplate, readonly HorizontalSpan[]>()
  const spansOf = (template: PlacedTemplate): readonly HorizontalSpan[] => {
    let held = spans.get(template)
    if (held === undefined) {
      held = horizontalSpans(template)
      spans.set(template, held)
    }
    return held
  }
  return {
    shows: (template) => intersectsTiles(template, spansOf(template), tiles),
    visibleRects: (template) =>
      visibleSourceRects(template, spansOf(template), tiles, bufferWidth, bufferHeight),
    forEachQuad: (template, entry, margin, vertices, draw) =>
      forEachTileQuad(
        template,
        spansOf(template),
        entry,
        tiles,
        bufferWidth,
        bufferHeight,
        margin,
        vertices,
        draw,
      ),
  }
}

/**
 * The context these handles belong to.
 *
 * `onAdd` can belong to a replacement map without the old one ever delivering `onRemove`. The
 * reverse happens too: Wplace can build the new map before tearing the old one down, and an
 * unguarded `onRemove` would delete the *new* context's handles, so nothing draws again until the
 * page is reloaded.
 */
let owner: WebGL2RenderingContext | null = null
let overlay: TemplatePass | null = null
/** The overlay's uploads, which the outline reads too: it runs earlier in the frame and uploads none. */
let gpu: TemplateGpuStore | null = null
let renderGeneration = 0
let outlineOwner: WebGL2RenderingContext | null = null
let outline: TemplatePass | null = null
let lastOutlineQuadKey = ''

export const overlayGpuMemoryBytes = (): number =>
  (overlay?.memoryBytes() ?? 0) + (gpu?.memoryBytes() ?? 0)

registerProfileMemorySource('Overlay GPU buffers', overlayGpuMemoryBytes)
/** Shift every template by fractional canvas pixels for alignment diagnostics. */
registerDebugEntry('nudge', (x = 0, y = 0) => {
  const applied = setNudge(x, y)
  redraw()
  return `[caelestis] overlay nudged by ${applied.x}, ${applied.y} canvas px — __caelestis.nudge() to clear`
})

/**
 * Run one of our layers' draws without letting a throw escape into MapLibre's render loop. A throw
 * from a custom layer takes the whole frame with it, and MapLibre stops rendering afterwards: the
 * canvas freezes on its last framebuffer while the page still looks alive.
 */
const guardedRender = (gl: WebGL2RenderingContext, name: string, draw: () => void): void => {
  try {
    profileGpu(gl, `${name} GPU`, () => measureProfile(`${name} render`, draw))
  } catch (error) {
    warn('install', `${name.toLowerCase()} layer render failed; skipping this frame`, String(error))
  }
}

const drawOverlay = (gl: WebGL2RenderingContext, pass: TemplatePass, store: TemplateGpuStore) => {
  const now = performance.now()
  const peek = overlayPeekFade(now)
  if (peek.opacity <= 0 && peek.done) return
  // Stop where Wplace stops: past the zoom where their tiles disappear, there is nothing to annotate.
  const tiles = isDrawingTiles() ? currentQuads() : []
  if (tiles.length === 0) {
    noteTemplatesInView(WORLD_TEMPLATE_SURFACE, NOTHING_IN_VIEW)
    return
  }
  const all = displayTemplatesForSurface(WORLD_TEMPLATE_SURFACE)
  renderGeneration++
  // Switched off is a destination, not an exclusion: a template on its way out is still drawn,
  // at falling opacity, and only leaves once its ramp has run out.
  const scene = worldRenderScene.advanceTemplates(
    all,
    WORLD_TEMPLATE_SURFACE,
    now,
    prefersReducedMotion(),
    tiles,
  )
  const placement = tilePlacement(tiles, gl.drawingBufferWidth, gl.drawingBufferHeight)
  const visible = pass.visible(scene.templates, placement)
  // Offscreen textures can be large. Keep only the templates this frame could actually draw;
  // panning back uploads them lazily again.
  const visibleIds = new Set(visible.map(({ template }) => template.id))
  store.collect(new Set(all.map(({ id }) => id)), visibleIds)
  noteTemplatesInView(WORLD_TEMPLATE_SURFACE, visibleIds)
  const profiling = isProfileEnabled()
  // MapLibre renders on demand, so a frame nobody asked for never happens: a fade would advance
  // only as far as the next pan. A newly visible template has no drawable entry on its first frame,
  // but its fade still needs the next one.
  if (visible.length === 0) {
    if (profiling) {
      recordProfileWorkload('Overlay host tiles', tiles.length)
      recordProfileWorkload('Overlay visible source pixels', 0)
      recordProfileWorkload('Overlay visible templates', 0)
      recordProfileWorkload('Overlay draw intersections', 0)
      recordProfileWorkload('Overlay uploaded index pixels', 0)
      recordProfileWorkload('Overlay minify tap cap', 0)
    }
    if (scene.animating || !peek.done) requestMapFrame()
    return
  }
  // During a drag, distributed samples retain anti-moire coverage while leaving enough GPU budget
  // for Wplace to move its own raster tiles. The first settled frame returns to the full grid.
  const moving = getMap()?.isMoving() === true
  const minifyTapCap = moving ? movingOverlayTapCap(visible.length) : SETTLED_TAP_CAP
  let result = { drawIntersections: 0, uploadedPixels: 0, uploaded: false }
  try {
    result = pass.draw(visible, {
      placement,
      store,
      uploadAllowance: TEMPLATE_UPLOAD_PIXELS_PER_FRAME,
      generation: renderGeneration,
      peekOpacity: peek.opacity,
      minifyTapCap,
    })
  } finally {
    if (profiling) {
      recordProfileWorkload('Overlay host tiles', tiles.length)
      recordProfileWorkload(
        'Overlay visible source pixels',
        visible.reduce((total, { template }) => total + template.width * template.height, 0),
      )
      recordProfileWorkload('Overlay visible templates', visible.length)
      recordProfileWorkload('Overlay draw intersections', result.drawIntersections)
      recordProfileWorkload('Overlay uploaded index pixels', result.uploadedPixels)
      recordProfileWorkload('Overlay minify tap cap', minifyTapCap)
      recordProfileWorkload('Overlay moving', moving ? 1 : 0)
      if (moving) {
        recordProfileWorkload('Overlay moving draw intersections', result.drawIntersections)
        recordProfileWorkload('Overlay moving minify tap cap', minifyTapCap)
      }
    }
    // An upload also needs the next frame for the outline, which ran earlier in this one, to catch
    // up on the new chunks.
    if (scene.animating || !peek.done || result.uploaded) requestMapFrame()
  }
}

export const overlayLayer = {
  id: LAYER_IDS.overlay,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    // Handles from a replaced context belong to it; forget them and rebuild for this one.
    owner = gl
    gpu = new TemplateGpuStore(gl)
    renderGeneration = 0
    overlay = TemplatePass.create(gl, 'overlay')
    if (overlay !== null) log('install', 'overlay layer added to Wplace’s own canvas')
  },

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    if (owner !== gl) return
    // Nothing is drawn any more, so nothing stays pinned in memory for this layer.
    noteTemplatesInView(WORLD_TEMPLATE_SURFACE, NOTHING_IN_VIEW)
    clearGpuProfile(gl)
    owner = null
    gpu?.dispose()
    gpu = null
    overlay?.dispose()
    overlay = null
  },

  render(gl: WebGL2RenderingContext): void {
    const pass = overlay
    const store = gpu
    if (pass === null || store === null) return
    guardedRender(gl, 'Overlay', () => drawOverlay(gl, pass, store))
  },
}

const drawOutline = (gl: WebGL2RenderingContext, pass: TemplatePass, store: TemplateGpuStore) => {
  const now = performance.now()
  const peek = overlayPeekFade(now)
  if ((peek.opacity <= 0 && peek.done) || !isDrawingTiles()) return
  const scene = worldRenderScene.advanceTemplates(
    displayTemplatesForSurface(WORLD_TEMPLATE_SURFACE),
    WORLD_TEMPLATE_SURFACE,
    now,
    prefersReducedMotion(),
    currentQuads(),
  )
  const settling = scene.animating || !peek.done
  if (
    !scene.templates.some(
      ({ fade, outlineFade, palette }) => fade > 0 && outlineFade > 0 && palette !== null,
    )
  ) {
    if (isProfileEnabled()) {
      recordProfileWorkload('Outline host tiles', 0)
      recordProfileWorkload('Outline visible templates', 0)
      recordProfileWorkload('Outline draw intersections', 0)
    }
    if (settling) requestMapFrame()
    return
  }
  // MapLibre exposes the same tile matrices its raster layer uploads later in this frame; the
  // previous frame's intercepted quads are only the fallback when that private state is missing.
  const tiles = underlayQuads()
  if (tiles.length === 0) return
  const quadKey = tiles
    .map(({ tile, x, y, width, height }) => `${tile.x}:${tile.y}:${x}:${y}:${width}:${height}`)
    .join('|')
  if (quadKey !== lastOutlineQuadKey) {
    lastOutlineQuadKey = quadKey
    // Wplace records the settled quads later in this frame. One follow-up repaint lets the next
    // outline pass use those exact positions without a continuous render loop.
    requestMapFrame()
  }
  const placement = tilePlacement(tiles, gl.drawingBufferWidth, gl.drawingBufferHeight)
  const visible = pass.visible(scene.templates, placement)
  const { drawIntersections } = pass.draw(visible, {
    placement,
    store,
    uploadAllowance: null,
    generation: renderGeneration,
    peekOpacity: peek.opacity,
    minifyTapCap: SETTLED_TAP_CAP,
  })
  if (isProfileEnabled()) {
    recordProfileWorkload('Outline host tiles', tiles.length)
    recordProfileWorkload(
      'Outline visible templates',
      visible.filter(({ template }) => store.entry(template.id) !== null).length,
    )
    recordProfileWorkload('Outline draw intersections', drawIntersections)
  }
  if (settling) requestMapFrame()
}

/**
 * A cheap silhouette below Wplace's art.
 *
 * Painted art covers this layer naturally; the coloured overlay later covers the middle of the
 * silhouette. This is the whole painted/unpainted test, expressed by layer order instead of a CPU
 * scan and sparse index-texture rewrites.
 */
export const outlineLayer = {
  id: LAYER_IDS.outline,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    outlineOwner = gl
    lastOutlineQuadKey = ''
    outline = TemplatePass.create(gl, 'outline')
    if (outline !== null) log('install', 'outline layer added below Wplace art')
  },

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    if (outlineOwner !== gl) return
    outlineOwner = null
    outline?.dispose()
    outline = null
    lastOutlineQuadKey = ''
  },

  render(gl: WebGL2RenderingContext): void {
    const pass = outline
    const store = gpu
    if (pass === null || store === null) return
    guardedRender(gl, 'Outline', () => drawOutline(gl, pass, store))
  },
}
