import type { TemplateSurface } from '@caelestis/shared'
import { artboardGeometry } from '../alliance-coordinates.js'
import {
  type ActiveAllianceSurface,
  activeAllianceSurface,
  onActiveAllianceSurfaceChange,
  onHeadquartersRevisionChange,
} from '../alliance-surface.js'
import { type CanvasDraw, onCanvasWrite } from '../canvas-write.js'
import { warn } from '../debug.js'
import type { PixelRect, Placement } from '../geometry.js'
import { notifyArtboardViewChange, onRedraw } from '../map-view.js'
import { onOverlayPeekChange, overlayPeekFade } from '../overlay-peek.js'
import {
  isProfileEnabled,
  measureProfile,
  profileGpu,
  recordProfileWorkload,
  registerProfileMemorySource,
} from '../profile.js'
import { getState } from '../settings.js'
import { displayTemplatesForSurface, isTemplateDraft } from '../templates/catalog.js'
import { fixedMarkList, type MarkList, markSeed } from '../templates/mark-list.js'
import { abortMoveOutsideSurface } from '../templates/move.js'
import { noteTemplatesInView } from '../templates/residency.js'
import { selectedColour } from '../wplace-paint.js'
import {
  type ArtboardMarkerBatch,
  ArtboardMarkerIndex,
  type ArtboardMarkerWork,
} from './artboard-markers.js'
import {
  ARTBOARD_CANVAS_ATTRIBUTES,
  artboardCanvasWriteRect,
  isArtboardCrosshairCanvas,
  isCaelestisCanvas,
  isHeadquartersTileLayer,
  onArtboardPixelsChange,
  patchArtboardPixels,
  readArtboardPixels,
  refreshArtboardPixels,
  trackArtboardTiles,
  watchArtboardDraftMarks,
} from './artboard-pixels.js'
import type { MarkerBatch } from './marker-batching.js'
import { visibleListPoints, visibleSourceRect } from './marker-density.js'
import { budgetMarkers, markerStyles } from './marker-frame.js'
import { MarkerRenderer, type MarkerStyle } from './marker-renderer.js'
import { minifyTapCap } from './minify-quality.js'
import { RenderScene, type SceneTemplate } from './render-scene.js'
import { writeQuad } from './renderer-core.js'
import {
  TEMPLATE_GPU_CACHE_BYTES,
  TEMPLATE_UPLOAD_PIXELS_PER_FRAME,
  TemplateGpuStore,
  type TemplateGpuTile,
} from './template-gpu-store.js'
import {
  TemplatePass,
  type TemplatePassFrame,
  type TemplatePassKind,
  type TemplatePassResult,
  type TemplatePlacement,
} from './template-pass.js'

/**
 * How long a moved template rests before its markers are compared at the new place.
 *
 * A comparison reads every pixel of the template, far too slow to repeat on each frame of a drag
 * or a held arrow key.
 */
const MARKER_SETTLE_MS = 150

interface ArtboardViewport {
  readonly bufferWidth: number
  readonly bufferHeight: number
  readonly frameLeft: number
  readonly frameTop: number
  readonly frameWidth: number
  readonly frameHeight: number
}

/** Geometry identity for focus and movement work that depends on both the stage and frame. */
const artboardViewportKey = (viewport: ArtboardViewport): string =>
  [
    viewport.bufferWidth,
    viewport.bufferHeight,
    viewport.frameLeft,
    viewport.frameTop,
    viewport.frameWidth,
    viewport.frameHeight,
  ].join(':')

/** What the artboard's screen-space controls are drawn against while it has usable geometry. */
export interface ArtboardView {
  readonly active: ActiveAllianceSurface
  readonly geometry: Placement
  readonly canvas: HTMLCanvasElement
  readonly rerender: () => void
}

/** Signed HQ placement becomes frame-local only at this final projection boundary. */
const artboardPlacement = (template: Placement, geometry: Placement) => ({
  left: template.originX - geometry.originX,
  top: template.originY - geometry.originY,
  right: template.originX - geometry.originX + template.width,
  bottom: template.originY - geometry.originY + template.height,
})

/** Project an artboard cell rectangle into the viewport-resolution WebGL backing store. */
const artboardDevicePlacement = (
  template: Placement,
  geometry: Placement,
  viewport: ArtboardViewport,
  margin = 0,
) => {
  const placement = artboardPlacement(template, geometry)
  const scaleX = viewport.frameWidth / geometry.width
  const scaleY = viewport.frameHeight / geometry.height
  return {
    left: viewport.frameLeft + (placement.left - margin) * scaleX,
    top: viewport.frameTop + (placement.top - margin) * scaleY,
    right: viewport.frameLeft + (placement.right + margin) * scaleX,
    bottom: viewport.frameTop + (placement.bottom + margin) * scaleY,
  }
}

/** Whether a template, grown by `margin` cells, shows: inside the frame and on the stage's buffer. */
const overlapsArtboardFrame = (
  template: Placement,
  geometry: Placement,
  viewport: ArtboardViewport,
  margin = 0,
): boolean => {
  const box = artboardDevicePlacement(template, geometry, viewport, margin)
  return (
    box.right > Math.max(0, viewport.frameLeft) &&
    box.bottom > Math.max(0, viewport.frameTop) &&
    box.left < Math.min(viewport.bufferWidth, viewport.frameLeft + viewport.frameWidth) &&
    box.top < Math.min(viewport.bufferHeight, viewport.frameTop + viewport.frameHeight)
  )
}

/** The part of a template inside the frame and on the stage's buffer, in template coordinates. */
const artboardVisibleRects = (
  template: Placement,
  geometry: Placement,
  viewport: ArtboardViewport,
): readonly PixelRect[] => {
  const scaleX = viewport.frameWidth / geometry.width
  const scaleY = viewport.frameHeight / geometry.height
  const offsetX = geometry.originX - template.originX
  const offsetY = geometry.originY - template.originY
  const left = Math.max(0, Math.floor(offsetX), Math.floor(-viewport.frameLeft / scaleX + offsetX))
  const top = Math.max(0, Math.floor(offsetY), Math.floor(-viewport.frameTop / scaleY + offsetY))
  const right = Math.min(
    template.width,
    Math.ceil(geometry.width + offsetX),
    Math.ceil((viewport.bufferWidth - viewport.frameLeft) / scaleX + offsetX),
  )
  const bottom = Math.min(
    template.height,
    Math.ceil(geometry.height + offsetY),
    Math.ceil((viewport.bufferHeight - viewport.frameTop) / scaleY + offsetY),
  )
  return right > left && bottom > top
    ? [{ x: left, y: top, width: right - left, height: bottom - top }]
    : []
}

/** Project one shared GPU chunk, including only the outer outline halo, into an artboard. */
export const artboardGpuTilePlacement = (
  template: Placement,
  source: Omit<TemplateGpuTile, 'texture'>,
  geometry: Placement,
  viewport: ArtboardViewport,
  margin: number,
) => {
  const halo = Math.min(margin, source.inset)
  const leftMargin = source.openLeft ? halo : 0
  const topMargin = source.openTop ? halo : 0
  const rightMargin = source.openRight ? halo : 0
  const bottomMargin = source.openBottom ? halo : 0
  return {
    box: artboardDevicePlacement(
      {
        originX: template.originX + source.x - leftMargin,
        originY: template.originY + source.y - topMargin,
        width: source.width + leftMargin + rightMargin,
        height: source.height + topMargin + bottomMargin,
      },
      geometry,
      viewport,
    ),
    u0: (source.inset - leftMargin) / source.textureWidth,
    v0: (source.inset - topMargin) / source.textureHeight,
    u1: (source.inset + source.width + rightMargin) / source.textureWidth,
    v1: (source.inset + source.height + bottomMargin) / source.textureHeight,
  }
}

/** A batch's marks as a drawable list, seeded by the batch's place so batches sample apart. */
const batchMarkList = (batch: ArtboardMarkerBatch): MarkList =>
  fixedMarkList(
    batch.marks,
    markSeed(Math.floor(batch.x / batch.width), Math.floor(batch.y / batch.height)),
  )

/** Count marker points in the blocks the current alliance artboard viewport shows, as submitted. */
const visibleArtboardMarkerPoints = (
  batch: ArtboardMarkerBatch,
  geometry: Placement,
  viewport: ArtboardViewport,
): number => {
  const box = artboardDevicePlacement(
    { originX: batch.x, originY: batch.y, width: batch.width, height: batch.height },
    geometry,
    viewport,
  )
  return visibleListPoints(
    batchMarkList(batch),
    visibleSourceRect(
      { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top },
      viewport.bufferWidth,
      viewport.bufferHeight,
      batch.width,
      batch.height,
    ),
  )
}

/** Match the world pass order: outline, native art, overlay, native draft, then markers. */
export const insertAllianceArtboardCanvases = (
  frame: HTMLElement,
  outline: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  markers: HTMLCanvasElement,
): void => {
  outline.style.imageRendering = 'pixelated'
  overlay.style.imageRendering = 'pixelated'
  markers.style.imageRendering = 'pixelated'
  // The picture and banner art is an in-flow canvas, and positioned siblings paint above in-flow
  // ones whatever their DOM order. A negative z-index keeps the outline under that art; the frame's
  // pan transform makes it the stacking context, so the outline stays above its checkerboard.
  outline.style.zIndex = '-1'
  frame.insertBefore(outline, frame.firstChild)
  // HQ art is a `.hq-tile-layer`: once a container of tile canvases, now one canvas. Either way it
  // is native art, never the draft canvas the overlay sits under.
  const hasHqTiles = [...frame.children].some((child) => child.classList.contains('hq-tile-layer'))
  const directCanvases = [...frame.children].filter(
    (child): child is HTMLCanvasElement =>
      child.tagName === 'CANVAS' &&
      !isCaelestisCanvas(child) &&
      !child.classList.contains('hq-tile-layer'),
  )
  const nativeDraft = hasHqTiles
    ? (directCanvases[0] ?? null)
    : directCanvases.length >= 2
      ? (directCanvases.at(-1) ?? null)
      : null
  frame.insertBefore(overlay, nativeDraft)
  frame.insertBefore(markers, nativeDraft?.nextSibling ?? null)
}

interface MarkerLayer {
  readonly batch: ArtboardMarkerBatch
  readonly tile: object
  readonly marks: MarkList
  readonly style: MarkerStyle
  readonly fade: number
}

type RenderMarker = MarkerBatch<MarkerLayer> & { readonly sampleRate: number }

const NOTHING_DRAWN: TemplatePassResult = {
  drawIntersections: 0,
  uploadedPixels: 0,
  uploaded: false,
  pending: false,
}

/** Templates placed on the artboard frame's rectangle within the stage's buffer. */
const framePlacement = (geometry: Placement, viewport: ArtboardViewport): TemplatePlacement => ({
  shows: (template, margin) => overlapsArtboardFrame(template, geometry, viewport, margin),
  visibleRects: (template) => artboardVisibleRects(template, geometry, viewport),
  forEachQuad: (template, entry, margin, vertices, draw) => {
    for (const source of entry.indices) {
      const placement = artboardGpuTilePlacement(template, source, geometry, viewport, margin)
      writeQuad(placement.box, placement, viewport.bufferWidth, viewport.bufferHeight, vertices)
      draw(source)
    }
  },
})

/** One of our canvases in the artboard: a WebGL context covering the stage, resized with it. */
class ArtboardCanvas {
  private constructor(
    readonly element: HTMLCanvasElement,
    readonly gl: WebGL2RenderingContext,
  ) {}

  static create(document: Document, attribute: string): ArtboardCanvas | null {
    const element = document.createElement('canvas')
    element.setAttribute(attribute, '')
    element.setAttribute('aria-hidden', 'true')
    Object.assign(element.style, {
      position: 'absolute',
      pointerEvents: 'none',
      imageRendering: 'pixelated',
    } satisfies Partial<CSSStyleDeclaration>)
    const gl = element.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    })
    return gl === null ? null : new ArtboardCanvas(element, gl)
  }

  clear(): void {
    const { gl, element } = this
    gl.disable(gl.SCISSOR_TEST)
    gl.viewport(0, 0, element.width, element.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Limit drawing to the frame; false when none of it is on the buffer. Disable the scissor after. */
  clipToFrame(viewport: ArtboardViewport): boolean {
    const { gl, element } = this
    const left = Math.max(0, Math.floor(viewport.frameLeft))
    const top = Math.max(0, Math.floor(viewport.frameTop))
    const right = Math.min(element.width, Math.ceil(viewport.frameLeft + viewport.frameWidth))
    const bottom = Math.min(element.height, Math.ceil(viewport.frameTop + viewport.frameHeight))
    if (right <= left || bottom <= top) return false
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(left, element.height - bottom, right - left, bottom - top)
    return true
  }
}

/** The artboard's outline or overlay: a template pass on its own canvas, with its own uploads. */
class ArtboardTemplates {
  private constructor(
    readonly surface: ArtboardCanvas,
    private readonly pass: TemplatePass,
    private readonly store: TemplateGpuStore,
  ) {}

  static create(document: Document, kind: TemplatePassKind): ArtboardTemplates | null {
    const surface = ArtboardCanvas.create(document, ARTBOARD_CANVAS_ATTRIBUTES[kind])
    if (surface === null) return null
    const pass = TemplatePass.create(surface.gl, kind)
    if (pass === null) return null
    // The artboard's two passes upload separately, so each gets half the world's cache.
    const store = new TemplateGpuStore(surface.gl, Math.floor(TEMPLATE_GPU_CACHE_BYTES / 2))
    return new ArtboardTemplates(surface, pass, store)
  }

  /**
   * Draw this pass's `templates` inside the frame, clearing what the last frame drew. `ids` are all
   * the surface's templates, so the store keeps nothing of one that is gone.
   */
  render(
    templates: readonly SceneTemplate[],
    ids: ReadonlySet<string>,
    geometry: Placement,
    viewport: ArtboardViewport,
    frame: Omit<TemplatePassFrame, 'placement' | 'store'>,
  ): TemplatePassResult {
    const name = this.pass.kind === 'outline' ? 'Alliance outline' : 'Alliance overlay'
    return profileGpu(this.surface.gl, `${name} GPU`, () =>
      measureProfile(`${name} render`, () => {
        this.surface.clear()
        if (frame.peekOpacity <= 0) return NOTHING_DRAWN
        const placement = framePlacement(geometry, viewport)
        const visible = this.pass.visible(templates, placement)
        this.store.collect(ids, new Set(visible.map(({ template }) => template.id)))
        if (!this.surface.clipToFrame(viewport)) return NOTHING_DRAWN
        const result = this.pass.draw(visible, { ...frame, placement, store: this.store })
        this.surface.gl.disable(this.surface.gl.SCISSOR_TEST)
        return result
      }),
    )
  }

  memoryBytes(): number {
    return this.store.memoryBytes()
  }

  dispose(): void {
    this.store.dispose()
    this.pass.dispose()
    this.surface.element.remove()
  }
}

/** The artboard's markers, on a canvas of their own above Wplace's draft. */
class ArtboardMarkers {
  private constructor(
    readonly surface: ArtboardCanvas,
    private readonly renderer: MarkerRenderer,
  ) {}

  static create(document: Document): ArtboardMarkers | null {
    const surface = ArtboardCanvas.create(document, ARTBOARD_CANVAS_ATTRIBUTES.markers)
    return surface === null ? null : new ArtboardMarkers(surface, new MarkerRenderer(surface.gl))
  }

  render(
    markers: readonly RenderMarker[],
    geometry: Placement,
    viewport: ArtboardViewport,
    peekOpacity: number,
  ): void {
    const { gl } = this.surface
    profileGpu(gl, 'Alliance markers GPU', () =>
      measureProfile('Alliance markers render', () => {
        this.surface.clear()
        if (peekOpacity <= 0 || !this.surface.clipToFrame(viewport)) return
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.disable(gl.DEPTH_TEST)
        const scaleX = viewport.frameWidth / geometry.width
        const scaleY = viewport.frameHeight / geometry.height
        this.renderer.beginFrame()
        for (const marker of markers) {
          const { batch } = marker
          this.renderer.draw(
            {
              x: viewport.frameLeft + (batch.x - geometry.originX) * scaleX,
              y: viewport.frameTop + (batch.y - geometry.originY) * scaleY,
              width: batch.width * scaleX,
              height: batch.height * scaleY,
              pixelWidth: batch.width,
              pixelHeight: batch.height,
            },
            marker.marks,
            marker.style,
            marker.fade * peekOpacity,
            marker.sampleRate,
          )
        }
        this.renderer.endFrame()
        gl.disable(gl.SCISSOR_TEST)
      }),
    )
  }

  memoryBytes(): number {
    return this.renderer.memoryBytes()
  }

  dispose(): void {
    this.renderer.dispose()
    this.surface.element.remove()
  }
}

class ArtboardRenderer {
  private readonly scene = new RenderScene()
  private readonly markerTiles = new Map<string, object>()
  private readonly observer: MutationObserver
  private readonly resizeObserver: ResizeObserver | null
  private readonly stopDraftMarks: () => void
  private framePending = false
  private markerPixelsDirty = true
  private readonly markerDirtyRects: PixelRect[] = []
  private readonly markerWork = new Map<
    string,
    {
      readonly index: ArtboardMarkerIndex
      readonly work: ArtboardMarkerWork
      readonly originX: number
      readonly originY: number
    }
  >()
  /** Where and when each moved template last changed place, until its markers catch up. */
  private readonly movedAt = new Map<
    string,
    { readonly x: number; readonly y: number; readonly at: number }
  >()
  /** Moving templates that skipped a native pixel change, so they compare in full once at rest. */
  private readonly missedPixels = new Set<string>()
  private renderGeneration = 0
  private lastViewportKey: string | null | undefined
  private settleFramePending = false
  private disposed = false

  private constructor(
    private readonly active: ActiveAllianceSurface,
    readonly surface: TemplateSurface,
    readonly geometry: Placement,
    private readonly outline: ArtboardTemplates,
    private readonly overlay: ArtboardTemplates,
    private readonly markers: ArtboardMarkers,
    private readonly onViewportChange: () => void,
    private readonly onView: (view: ArtboardView | null) => void,
  ) {
    this.observer = new MutationObserver(() => this.requestRender())
    this.observer.observe(active.frame, { attributes: true, attributeFilter: ['class', 'style'] })
    this.observer.observe(active.stage, { attributes: true, attributeFilter: ['class', 'style'] })
    this.resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.requestRender()) : null
    this.resizeObserver?.observe(active.frame)
    this.resizeObserver?.observe(active.stage)
    this.stopDraftMarks = watchArtboardDraftMarks(active)
  }

  static create(
    active: ActiveAllianceSurface,
    geometry: Placement,
    onViewportChange: () => void,
    onView: (view: ArtboardView | null) => void,
  ): ArtboardRenderer | null {
    const outline = ArtboardTemplates.create(active.frame.ownerDocument, 'outline')
    const overlay = ArtboardTemplates.create(active.frame.ownerDocument, 'overlay')
    const markers = ArtboardMarkers.create(active.frame.ownerDocument)
    if (outline === null || overlay === null || markers === null) {
      outline?.dispose()
      overlay?.dispose()
      markers?.dispose()
      return null
    }
    insertAllianceArtboardCanvases(
      active.frame,
      outline.surface.element,
      overlay.surface.element,
      markers.surface.element,
    )
    return new ArtboardRenderer(
      active,
      active.surface,
      geometry,
      outline,
      overlay,
      markers,
      onViewportChange,
      onView,
    )
  }

  private syncViewport(): ArtboardViewport | null {
    const stage = this.active.stage.getBoundingClientRect()
    const frame = this.active.frame.getBoundingClientRect()
    if (stage.width <= 0 || stage.height <= 0 || frame.width <= 0 || frame.height <= 0) return null
    const dpr = this.active.stage.ownerDocument.defaultView?.devicePixelRatio || 1
    const bufferWidth = Math.max(1, Math.round(stage.width * dpr))
    const bufferHeight = Math.max(1, Math.round(stage.height * dpr))
    for (const { surface } of [this.outline, this.overlay, this.markers]) {
      const canvas = surface.element
      const left = `${stage.left - frame.left}px`
      const top = `${stage.top - frame.top}px`
      const width = `${stage.width}px`
      const height = `${stage.height}px`
      if (canvas.style.left !== left) canvas.style.left = left
      if (canvas.style.top !== top) canvas.style.top = top
      if (canvas.style.width !== width) canvas.style.width = width
      if (canvas.style.height !== height) canvas.style.height = height
      if (canvas.width !== bufferWidth) canvas.width = bufferWidth
      if (canvas.height !== bufferHeight) canvas.height = bufferHeight
    }
    const scaleX = bufferWidth / stage.width
    const scaleY = bufferHeight / stage.height
    return {
      bufferWidth,
      bufferHeight,
      frameLeft: (frame.left - stage.left) * scaleX,
      frameTop: (frame.top - stage.top) * scaleY,
      frameWidth: frame.width * scaleX,
      frameHeight: frame.height * scaleY,
    }
  }

  private viewportIsMoving(viewport: ArtboardViewport | null): boolean {
    const key = viewport === null ? null : artboardViewportKey(viewport)
    const changed = key !== this.lastViewportKey
    const moving = this.lastViewportKey !== undefined && key !== null && changed
    this.lastViewportKey = key
    if (changed) this.onViewportChange()
    if (moving) this.settleFramePending = true
    else if (this.settleFramePending) this.settleFramePending = false
    return moving
  }

  requestRender(): void {
    if (this.disposed || this.framePending) return
    this.framePending = true
    const schedule =
      this.active.stage.ownerDocument.defaultView?.requestAnimationFrame ?? requestAnimationFrame
    schedule(() => {
      this.framePending = false
      if (this.disposed) return
      try {
        this.draw()
      } catch (error) {
        warn('alliance artboard render failed; skipping this frame', String(error))
      }
    })
  }

  private markerTile(batch: ArtboardMarkerBatch): object {
    const key = `${batch.x}/${batch.y}/${batch.width}/${batch.height}`
    const held = this.markerTiles.get(key)
    if (held !== undefined) return held
    const created = {}
    this.markerTiles.set(key, created)
    return created
  }

  nativeCanvasWritten(canvas: object, dirty: PixelRect | null, draw: CanvasDraw | null): void {
    try {
      if (
        !(canvas instanceof HTMLCanvasElement) ||
        (!this.active.frame.contains(canvas) && !isArtboardCrosshairCanvas(this.active, canvas))
      )
        return
      const tiles = trackArtboardTiles(this.active, this.geometry, canvas, draw)
      this.markerDirtyRects.push(...tiles)
      // The layer's own write rects are screen pixels; only the tiles it reveals are artboard cells.
      if (isHeadquartersTileLayer(canvas)) {
        if (tiles.length > 0) this.requestRender()
        return
      }
      patchArtboardPixels(this.active, this.geometry, canvas, dirty)
      const rect = artboardCanvasWriteRect(this.active, this.geometry, canvas, dirty)
      if (rect === null) this.markerPixelsDirty = true
      else this.markerDirtyRects.push(rect)
      this.requestRender()
    } catch {
      // Offscreen and foreign-realm canvases cannot belong to this DOM artboard.
    }
  }

  nativePixelsChanged(): void {
    this.markerPixelsDirty = true
    this.markerDirtyRects.length = 0
    this.requestRender()
  }

  private draw(): void {
    const viewport = this.syncViewport()
    const moving = this.viewportIsMoving(viewport)
    if (viewport === null) {
      this.onView(null)
      noteTemplatesInView(this.surface, new Set())
      return
    }
    this.onView({
      active: this.active,
      geometry: this.geometry,
      canvas: this.overlay.surface.element,
      rerender: () => this.requestRender(),
    })
    const all = displayTemplatesForSurface(this.surface)
    this.renderGeneration++
    const ids = new Set(all.map(({ id }) => id))
    const now = performance.now()
    const peek = overlayPeekFade(now)
    const templateScene = this.scene.advanceTemplates(all, this.surface, now)
    const templates = templateScene.templates.filter(
      ({ fade, palette }) => fade > 0 && palette !== null,
    )
    const inFrame = templates.filter(({ template }) =>
      overlapsArtboardFrame(template, this.geometry, viewport),
    )
    noteTemplatesInView(this.surface, new Set(inFrame.map(({ template }) => template.id)))
    let animating = templateScene.animating
    const selected = selectedColour()
    const markerScene = this.scene.advanceMarkers(templateScene.templates, selected, now)
    if (markerScene.animating) animating = true
    let comparedMarkerPixels = 0
    // Markers compare pixels, so they cover only templates whose pixels are in memory. The editor's
    // draft changes with every setting and has no progress worth marking, as on the world map.
    const resident = templateScene.templates.flatMap(({ template, appearance }) => {
      const pixels = template.artwork.pixels
      return pixels === null || isTemplateDraft(template)
        ? []
        : [{ template: { ...template, pixels }, appearance }]
    })
    const residentIds = new Set(resident.map(({ template }) => template.id))
    // A template that moved hides its markers until it rests, then compares once at its new place.
    const placing = new Set<string>()
    for (const { template } of resident) {
      const held = this.markerWork.get(template.id)
      if (
        held === undefined ||
        (held.originX === template.originX && held.originY === template.originY)
      ) {
        this.movedAt.delete(template.id)
        continue
      }
      const last = this.movedAt.get(template.id)
      if (last === undefined || last.x !== template.originX || last.y !== template.originY) {
        this.movedAt.set(template.id, { x: template.originX, y: template.originY, at: now })
        placing.add(template.id)
      } else if (now - last.at < MARKER_SETTLE_MS) placing.add(template.id)
    }
    for (const id of this.movedAt.keys()) if (!residentIds.has(id)) this.movedAt.delete(id)
    for (const id of this.missedPixels) if (!residentIds.has(id)) this.missedPixels.delete(id)
    if (placing.size > 0) animating = true
    const staleMarkerIds = new Set(
      resident
        .filter(({ template, appearance }) => {
          if (placing.has(template.id)) return false
          if (this.missedPixels.has(template.id)) return true
          const held = this.markerWork.get(template.id)
          return held === undefined || !held.index.isCurrent(template, appearance)
        })
        .map(({ template }) => template.id),
    )
    if (this.markerPixelsDirty || this.markerDirtyRects.length > 0 || staleMarkerIds.size > 0) {
      const regions = readArtboardPixels(this.active, this.geometry)
      const pixelsChanged = this.markerPixelsDirty || this.markerDirtyRects.length > 0
      for (const { template, appearance } of resident) {
        if (placing.has(template.id)) {
          if (pixelsChanged) this.missedPixels.add(template.id)
          continue
        }
        const held = this.markerWork.get(template.id)
        const stale = staleMarkerIds.has(template.id)
        const rebuild =
          this.missedPixels.delete(template.id) ||
          this.markerPixelsDirty ||
          held === undefined ||
          !held.index.hasCurrentPixels(template, appearance)
        const intersectsDirty = this.markerDirtyRects.some(
          (dirty) =>
            dirty.x < template.originX + template.width &&
            dirty.x + dirty.width > template.originX &&
            dirty.y < template.originY + template.height &&
            dirty.y + dirty.height > template.originY,
        )
        if (!rebuild && !intersectsDirty && !stale) continue
        const index = held?.index ?? new ArtboardMarkerIndex()
        const work = index.update(
          template,
          regions,
          appearance,
          rebuild ? null : this.markerDirtyRects,
        )
        comparedMarkerPixels += index.comparedPixels()
        this.markerWork.set(template.id, {
          index,
          work,
          originX: template.originX,
          originY: template.originY,
        })
      }
      this.markerPixelsDirty = false
      this.markerDirtyRects.length = 0
    }
    for (const id of this.markerWork.keys()) if (!residentIds.has(id)) this.markerWork.delete(id)
    const selectedLayers: MarkerLayer[] = []
    const mismatchLayers: MarkerLayer[] = []
    for (const { rendered, mismatchFade, selectedFades } of markerScene.templates) {
      // A moving template's markers belong to where it was, so it shows none until it rests.
      if (rendered.fade <= 0 || placing.has(rendered.template.id)) continue
      const indexed = this.markerWork.get(rendered.template.id)
      if (indexed === undefined) continue
      const { work } = indexed
      const styles = markerStyles(rendered.appearance, this.surface, selected)
      for (const selectedFade of selectedFades) {
        const selectedWork = work.selected.find(({ index }) => index === selectedFade.index)
        if (selectedWork === undefined) continue
        for (const batch of selectedWork.batches) {
          selectedLayers.push({
            batch,
            tile: this.markerTile(batch),
            marks: batchMarkList(batch),
            style: styles.selected,
            fade: selectedFade.fade,
          })
        }
      }
      for (const batch of work.mismatch)
        mismatchLayers.push({
          batch,
          tile: this.markerTile(batch),
          marks: batchMarkList(batch),
          style: styles.mismatch,
          fade: mismatchFade,
        })
    }
    const { batches: markerLayers } = budgetMarkers(
      selectedLayers,
      mismatchLayers,
      (layer) => visibleArtboardMarkerPoints(layer.batch, this.geometry, viewport),
      getState().markerBudget,
    )
    const tapCap = minifyTapCap(moving, templates.length)
    const outlineAllowance = Math.floor(TEMPLATE_UPLOAD_PIXELS_PER_FRAME / 2)
    const frame = {
      generation: this.renderGeneration,
      peekOpacity: peek.opacity,
      minifyTapCap: tapCap,
    }
    const outlineResult = this.outline.render(templates, ids, this.geometry, viewport, {
      ...frame,
      uploadAllowance: outlineAllowance,
    })
    const overlayResult = this.overlay.render(templates, ids, this.geometry, viewport, {
      ...frame,
      uploadAllowance: TEMPLATE_UPLOAD_PIXELS_PER_FRAME - outlineAllowance,
    })
    this.markers.render(markerLayers, this.geometry, viewport, peek.opacity)
    if (isProfileEnabled()) {
      recordProfileWorkload('Alliance overlay visible templates', templates.length)
      recordProfileWorkload(
        'Alliance overlay visible source pixels',
        templates.reduce((total, { template }) => total + template.width * template.height, 0),
      )
      recordProfileWorkload(
        'Alliance overlay draw intersections',
        outlineResult.drawIntersections + overlayResult.drawIntersections,
      )
      recordProfileWorkload(
        'Alliance overlay uploaded index pixels',
        outlineResult.uploadedPixels + overlayResult.uploadedPixels,
      )
      recordProfileWorkload('Alliance overlay minify tap cap', tapCap)
      recordProfileWorkload('Alliance overlay moving', moving ? 1 : 0)
      recordProfileWorkload('Alliance marker source batches', markerLayers.length)
      recordProfileWorkload(
        'Alliance marker source points',
        markerLayers.reduce(
          (total, marker) => marker.marks.reduce((sum, list) => sum + list.length, total),
          0,
        ),
      )
      recordProfileWorkload('Alliance marker compared pixels', comparedMarkerPixels)
      recordProfileWorkload(
        'Alliance marker draw batches saved',
        selectedLayers.length + mismatchLayers.length - markerLayers.length,
      )
    }
    if (outlineResult.pending || overlayResult.pending || moving || !peek.done) animating = true
    if (animating) this.requestRender()
  }

  memoryBytes(): number {
    return this.outline.memoryBytes() + this.overlay.memoryBytes() + this.markers.memoryBytes()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    noteTemplatesInView(this.surface, new Set())
    this.observer.disconnect()
    this.resizeObserver?.disconnect()
    this.stopDraftMarks()
    this.onView(null)
    this.outline.dispose()
    this.overlay.dispose()
    this.markers.dispose()
  }
}

let renderer: ArtboardRenderer | null = null
let onView: (view: ArtboardView | null) => void = () => {}

export const allianceOverlayGpuMemoryBytes = (): number => renderer?.memoryBytes() ?? 0

const reconcileRenderer = (): void => {
  const active = activeAllianceSurface()
  void abortMoveOutsideSurface(active?.surface ?? null)
  renderer?.dispose()
  renderer = null
  if (active === null) return
  const geometry = artboardGeometry(active)
  if (geometry === null || geometry.width <= 0 || geometry.height <= 0) return
  renderer = ArtboardRenderer.create(active, geometry, notifyArtboardViewChange, onView)
  renderer?.requestRender()
  void refreshArtboardPixels(active, geometry)
}

const repaintAllianceOverlayLayer = (): void => renderer?.requestRender()

/**
 * Attach viewport-resolution WebGL passes inside whichever Wplace alliance artboard is open. They
 * repaint on every `redraw`, and report their pans as view changes. `showControls` hears each
 * frame's view, or null while the artboard has no usable geometry.
 */
export const installAllianceOverlayLayer = (
  showControls: (view: ArtboardView | null) => void,
): void => {
  onView = showControls
  registerProfileMemorySource('Alliance overlay GPU buffers', allianceOverlayGpuMemoryBytes)
  onActiveAllianceSurfaceChange(reconcileRenderer)
  onHeadquartersRevisionChange((allianceId) => {
    queueMicrotask(() => {
      const active = activeAllianceSurface()
      if (
        active?.surface.kind !== 'alliance-headquarters' ||
        active.surface.allianceId !== allianceId
      )
        return
      const geometry = artboardGeometry(active)
      if (geometry !== null) void refreshArtboardPixels(active, geometry)
    })
  })
  onRedraw(repaintAllianceOverlayLayer)
  // Peek fades without a redraw: it touches no state the world map's frame reads.
  onOverlayPeekChange(repaintAllianceOverlayLayer)
  onArtboardPixelsChange(() => renderer?.nativePixelsChanged())
  onCanvasWrite((canvas, dirty, draw) => renderer?.nativeCanvasWritten(canvas, dirty, draw))
  reconcileRenderer()
}
