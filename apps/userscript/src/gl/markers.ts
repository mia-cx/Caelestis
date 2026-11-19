import { sameTemplateSurface, TILE_SIZE, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import type { TileQuad } from '../coordinates.js'
import { count, warn } from '../debug.js'
import { getMap } from '../map-handle.js'
import { requestMapFrame } from '../map-view.js'
import { overlayPeekFade } from '../overlay-peek.js'
import {
  isProfileEnabled,
  measureProfile,
  profileGpu,
  recordProfileWorkload,
  registerProfileMemorySource,
} from '../profile.js'
import { getState } from '../settings.js'
import { toRgbUnit } from '../templates/appearance.js'
import {
  displayTemplates,
  isTemplateVisible,
  type PlacedTemplate,
} from '../templates/local-store.js'
import type { MarkList } from '../templates/mark-list.js'
import { pixelAccounting } from '../templates/mismatch.js'
import { horizontalSpans } from '../templates/placement.js'
import { measuresLocally } from '../templates/wplace-owned.js'
import { currentQuads, isDrawingTiles } from '../tile-frame.js'
import { holdTilePixels } from '../tile-pixels.js'
import { selectedColour } from '../wplace-paint.js'
import { prefersReducedMotion } from './appearance-transition.js'
import { LAYER_IDS } from './layer-stack.js'
import { batchMarkerWork } from './marker-batching.js'
import {
  markerDensityMemoryBytes,
  markerSampleRate,
  visibleListPoints,
  visibleSourceRect,
} from './marker-density.js'
import { MarkerRenderer, type MarkerStyle } from './marker-renderer.js'
import { worldRenderScene } from './render-scene.js'

let worldMarkerRenderer: MarkerRenderer | null = null

const markerGpuMemoryBytes = (): number => worldMarkerRenderer?.memoryBytes() ?? 0
registerProfileMemorySource('Marker density buffers', markerDensityMemoryBytes)
registerProfileMemorySource('Marker GPU buffers', markerGpuMemoryBytes)
const initMarkers = (gl: WebGL2RenderingContext): void => {
  worldMarkerRenderer = new MarkerRenderer(gl)
}
const releaseMarkers = (gl: WebGL2RenderingContext): void => {
  if (worldMarkerRenderer?.gl !== gl) return
  worldMarkerRenderer.dispose()
  worldMarkerRenderer = null
}

/**
 * Draw one crosshair per marked pixel of one tile.
 *
 * Each list packs tile-local x/y/wanted-index into one uint per mark. Placement comes from the
 * tile's own on-screen rect, the same rect the overlay itself is drawn on, so markers inherit
 * whatever MapLibre did to place that tile rather than being projected separately.
 */
const drawMarkers = (
  gl: WebGL2RenderingContext,
  tile: TileQuad,
  pixels: readonly MarkList[],
  style: MarkerStyle,
  fade: number,
  sampleRate = 1,
): number => {
  if (worldMarkerRenderer?.gl !== gl) return 0
  return worldMarkerRenderer.draw(
    {
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      pixelWidth: TILE_SIZE,
      pixelHeight: TILE_SIZE,
    },
    pixels,
    style,
    fade,
    sampleRate,
  )
}

/**
 * The soonest a deferred scan may ask for another frame.
 *
 * Asking from inside a render callback is asking for the next frame from the frame you are in, so a
 * tile that can never be answered — because its pixels were never captured, say — turns into a
 * render loop at full rate that looks exactly like a hang. This makes the retry a heartbeat instead.
 */
const RETRY_MS = 250
let nextRetry = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Ask for another frame once the heartbeat allows it, from a timer.
 *
 * Asking only from inside a frame relied on some other frame arriving after the heartbeat was due.
 * Wplace's map used to render continuously, so one always did. Now an idle map renders nothing, and
 * a scan deferred behind a failed or queued tile chase would wait for the next unrelated movement.
 */
const retryDeferredScan = (now: number): void => {
  if (retryTimer !== null) return
  retryTimer = setTimeout(
    () => {
      retryTimer = null
      nextRetry = performance.now() + RETRY_MS
      requestMapFrame()
      count('marker:asked for another frame')
    },
    Math.max(0, nextRetry - now),
  )
}

/** Every marked pixel of every template that asks for it, over every tile on screen. */
const drawVisible = (
  gl: WebGL2RenderingContext,
  peek: { readonly opacity: number; readonly done: boolean },
): void => {
  const tiles = isDrawingTiles() ? currentQuads() : []
  if (tiles.length === 0) {
    holdTilePixels([])
    return
  }
  /**
   * Everything whose markers are still worth anything, which is not the same as everything that
   * asked for them.
   *
   * Switching markers off used to remove the template from this list, and every crosshair on it
   * vanished between two frames. On dense artwork that is indistinguishable from the overlay
   * breaking: a few thousand marks disappear at once and nothing says whether they were fixed,
   * filtered, or lost. So the switch is a destination — the marks keep being drawn at falling
   * opacity until the ramp runs out, and only then does the template drop off this list.
   */
  const now = performance.now()
  const selected = selectedColour() ?? -1
  const sceneTemplates = worldRenderScene.advanceTemplates(
    displayTemplates().filter((candidate) =>
      sameTemplateSurface(candidate.surface ?? WORLD_TEMPLATE_SURFACE, WORLD_TEMPLATE_SURFACE),
    ),
    WORLD_TEMPLATE_SURFACE,
    now,
    prefersReducedMotion(),
    tiles,
  )
  const sceneMarkers = worldRenderScene.advanceMarkers(
    sceneTemplates.templates,
    selected >= 0 ? selected : null,
    now,
  )
  const animating = sceneTemplates.animating || sceneMarkers.animating || !peek.done
  const wanted: {
    template: PlacedTemplate
    appearance: (typeof sceneTemplates.templates)[number]['appearance']
    mismatchFade: number
    selectedFades: readonly { index: number; fade: number }[]
  }[] = []
  const progressOnly: PlacedTemplate[] = []
  for (const { rendered, mismatchFade, selectedFades } of sceneMarkers.templates) {
    const { template, appearance } = rendered
    const hasSelectedFade = selectedFades.some(({ fade }) => fade > 0)
    if (
      measuresLocally(template) &&
      isTemplateVisible(template) &&
      mismatchFade === 0 &&
      !hasSelectedFade
    )
      progressOnly.push(template)
    if (mismatchFade > 0 || hasSelectedFade) {
      wanted.push({ template, appearance, mismatchFade, selectedFades })
    }
  }
  if (animating) requestMapFrame()
  if (wanted.length > 0) count('marker:layer rendered')
  // Only the tiles a template covers. Asking about a tile is not free — one whose pixels have not
  // been captured triggers a fetch and a 1000x1000 `getImageData`.
  const covers = (template: PlacedTemplate, tile: TileQuad): boolean => {
    const left = tile.tile.x * TILE_SIZE
    const top = tile.tile.y * TILE_SIZE
    if (
      !horizontalSpans(template).some(
        (span) => span.worldStart < left + TILE_SIZE && span.worldEnd > left,
      )
    )
      return false
    if (template.originY >= top + TILE_SIZE || template.originY + template.height <= top)
      return false
    return true
  }
  // Before asking for any, so capturing one this frame cannot evict another it needs.
  holdTilePixels(
    tiles.flatMap((tile) =>
      progressOnly.some((template) => covers(template, tile)) ||
      wanted.some(({ template }) => covers(template, tile))
        ? [tile.tile]
        : [],
    ),
  )

  type Work = {
    tile: TileQuad
    marks: MarkList
    style: MarkerStyle
    fade: number
  }
  const selectedWork: Work[] = []
  const mismatchWork: Work[] = []
  let deferred = false
  for (const template of progressOnly) {
    const accounting = pixelAccounting.read(template)
    for (const tile of tiles) {
      if (covers(template, tile) && !accounting.ensure(tile.tile)) deferred = true
    }
  }
  const { markerBudget, onlySelectedColour } = getState()
  const moving = getMap()?.isMoving() === true
  const renderBudget = markerBudget
  const profiling = isProfileEnabled()
  const mismatchSelection = onlySelectedColour ? selected : -1
  for (const { template, appearance, mismatchFade, selectedFades } of wanted) {
    const accounting = pixelAccounting.read(template)
    const mismatchStyle: MarkerStyle = {
      size: appearance.markerSize,
      thickness: 2,
      colour: toRgbUnit(appearance.markerColour),
      // One switch above both: off means every marker is drawn the same, and the fade and the second
      // colour keep their values for whenever it goes back on.
      otherColour:
        !appearance.dimOthers || appearance.otherColour === null
          ? null
          : toRgbUnit(appearance.otherColour),
      otherOpacity: appearance.dimOthers ? appearance.otherOpacity : 1,
      selected: mismatchSelection,
    }
    const selectedStyle: MarkerStyle = {
      size: appearance.selectedMarkerSize,
      thickness: 2,
      colour: toRgbUnit(appearance.selectedMarkerColour),
      otherColour: null,
      otherOpacity: 1,
      selected: -1,
    }
    for (const tile of tiles) {
      if (!covers(template, tile)) continue
      for (const selectedFade of selectedFades) {
        if (selectedFade.fade <= 0) continue
        const marks = accounting.unpainted(tile.tile, selectedFade.index)
        if (marks === null) deferred = true
        else if (marks.live > 0) {
          selectedWork.push({
            tile,
            marks,
            style: selectedStyle,
            fade: selectedFade.fade * peek.opacity,
          })
        }
      }
      if (mismatchFade > 0) {
        const tileAccounting = accounting.tile(tile.tile)
        if (tileAccounting === null) deferred = true
        else if (tileAccounting.markers.live > 0) {
          mismatchWork.push({
            tile,
            marks: tileAccounting.markers,
            style: mismatchStyle,
            fade: mismatchFade * peek.opacity,
          })
        }
      }
    }
  }
  const points = (work: readonly { readonly marks: { readonly length: number } }[]): number =>
    work.reduce((total, one) => total + one.marks.length, 0)
  const estimatedVisiblePoints = (work: readonly Work[]): number =>
    work.reduce(
      (total, { marks, tile }) =>
        total +
        visibleListPoints(
          marks,
          visibleSourceRect(tile, gl.drawingBufferWidth, gl.drawingBufferHeight),
        ),
      0,
    )
  const selectedSourcePoints = points(selectedWork)
  const mismatchSourcePoints = points(mismatchWork)
  const selectedSampleRate = markerSampleRate(estimatedVisiblePoints(selectedWork), renderBudget)
  const mismatchSampleRate = markerSampleRate(estimatedVisiblePoints(mismatchWork), renderBudget)
  const expectedSelectedPoints = Math.round(selectedSourcePoints * selectedSampleRate)
  const expectedMismatchPoints = Math.round(mismatchSourcePoints * mismatchSampleRate)
  const reportWorkload = (
    drawBatches: number,
    drawnPoints: number,
    submittedPoints: number,
  ): void => {
    if (!profiling) return
    const sourcePoints = selectedSourcePoints + mismatchSourcePoints
    const expectedPoints = expectedSelectedPoints + expectedMismatchPoints
    recordProfileWorkload('Marker eligible templates', wanted.length)
    recordProfileWorkload('Marker host tiles', tiles.length)
    recordProfileWorkload('Marker effective budget', renderBudget)
    recordProfileWorkload('Marker moving', moving ? 1 : 0)
    recordProfileWorkload('Marker source batches', selectedWork.length + mismatchWork.length)
    recordProfileWorkload('Marker source points', sourcePoints)
    recordProfileWorkload('Marker retained batches', selectedWork.length + mismatchWork.length)
    recordProfileWorkload('Marker retained points', expectedPoints)
    recordProfileWorkload('Marker submitted points', submittedPoints)
    recordProfileWorkload('Marker draw batches', drawBatches)
    recordProfileWorkload('Marker drawn points', drawnPoints)
    if (moving) {
      recordProfileWorkload('Marker moving effective budget', renderBudget)
      recordProfileWorkload('Marker moving retained points', expectedPoints)
      recordProfileWorkload('Marker moving draw batches', drawBatches)
      recordProfileWorkload('Marker moving drawn points', drawnPoints)
    }
  }
  count('marker:selected-colour tiles with marks', selectedWork.length)
  count('marker:mismatch tiles with marks', mismatchWork.length)

  if (selectedWork.length === 0 && mismatchWork.length === 0) {
    reportWorkload(0, 0, 0)
    if (deferred) retryDeferredScan(now)
    return
  }

  // MapLibre resets custom-layer defaults before calling us and invalidates its state cache after.
  // Synchronous state reads here would merely move the overlay's drag-time GPU stall to this layer.
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.disable(gl.DEPTH_TEST)

  // The selected colour is a guide; a real mismatch is the error signal and wins where they meet.
  const selectedDraws = batchMarkerWork(selectedWork)
  const mismatchDraws = batchMarkerWork(mismatchWork)
  const drawBatches = selectedDraws.length + mismatchDraws.length
  const drawnPoints = profiling ? expectedSelectedPoints + expectedMismatchPoints : 0
  count('marker:draw batches before batching', selectedWork.length + mismatchWork.length)
  count('marker:draw batches after batching', drawBatches)
  let submittedPoints = 0
  for (const one of selectedDraws)
    submittedPoints += drawMarkers(gl, one.tile, one.marks, one.style, one.fade, selectedSampleRate)
  for (const one of mismatchDraws)
    submittedPoints += drawMarkers(gl, one.tile, one.marks, one.style, one.fade, mismatchSampleRate)
  reportWorkload(drawBatches, drawnPoints, submittedPoints)

  if (deferred) retryDeferredScan(now)
}

const drawAll = (
  gl: WebGL2RenderingContext,
  peek: { readonly opacity: number; readonly done: boolean },
): void => {
  worldMarkerRenderer?.beginFrame()
  try {
    pixelAccounting.frame(() => drawVisible(gl, peek))
  } finally {
    worldMarkerRenderer?.endFrame()
  }
}

/**
 * The markers, in a layer of their own.
 *
 * The overlay belongs *under* a pixel waiting to be placed — that is what makes placing one look
 * like it covers the template. A marker is the opposite: an annotation about a pixel, which cannot
 * sit beneath the pixel it describes. One layer could not be both.
 */
export const markerLayer = {
  id: LAYER_IDS.markers,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  onAdd(_map: unknown, gl: WebGL2RenderingContext): void {
    initMarkers(gl)
    count('marker:layer added')
  },

  onRemove(_map: unknown, gl: WebGL2RenderingContext): void {
    releaseMarkers(gl)
    worldRenderScene.resetMarkers()
    holdTilePixels([])
  },

  render(gl: WebGL2RenderingContext): void {
    const peek = overlayPeekFade(performance.now())
    // Peek is display suppression, not cache invalidation. Once the fade reaches zero, stop before
    // `drawAll` so its normal unused-buffer sweep keeps every retained marker buffer warm.
    if (peek.opacity <= 0 && peek.done) return
    // Never let this escape into MapLibre's render loop; a throw here takes the whole frame with it.
    try {
      profileGpu(gl, 'Marker GPU', () => measureProfile('Marker render', () => drawAll(gl, peek)))
    } catch (error) {
      warn('install', 'marker layer render failed; skipping this frame', String(error))
    }
  },
}
