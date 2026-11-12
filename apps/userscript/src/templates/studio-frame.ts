import type { TemplateSurface } from '@caelestis/shared'
import type { StudioRect } from '@caelestis/ui/elements'
import { activeAllianceEditorStage } from '../alliance-surface.js'
import { placementScale, placementScreenPoint } from './move.js'

/**
 * The template studio's handles on the map.
 *
 * Around the draft, a handle on every corner and edge resizes it while the opposite side stays put.
 * Corners keep the draft's proportions and edges stretch one side; holding Shift swaps the two, so
 * a corner stretches freely and an edge keeps proportions about its middle. In crop mode the whole
 * source image shows at the draft's scale, dimmed outside the crop being drawn, with the same
 * handles, free unless Shift holds the crop's proportions; dragging inside the crop moves it, and
 * dragging elsewhere on the image draws a new one. The studio owns every value: this only turns
 * pointer gestures into sizes and crops, and draws what it is told.
 */

interface Point {
  readonly x: number
  readonly y: number
}

export interface StudioFrameView {
  readonly surface: TemplateSurface
  /** The draft's top-left corner and size, in canvas pixels. */
  readonly origin: Point
  readonly output: { readonly width: number; readonly height: number }
  /** The applied crop, in source pixels. */
  readonly crop: StudioRect
  readonly source: { readonly width: number; readonly height: number; readonly url: string }
  /** The crop being drawn, in source pixels. Null outside crop mode. */
  readonly cropping: StudioRect | null
  /** A replacement keeps its size: no size handles, and its crop keeps its proportions. */
  readonly locked: boolean
}

/** Which side of a box stays put along one axis while it resizes. */
export type FixedSide = 'start' | 'centre' | 'end'

export interface StudioFrameHandlers {
  /** Resize the draft to `box`, in canvas pixels, keeping its `fixed` sides where they are. */
  readonly resize: (box: Box, fixed: { readonly x: FixedSide; readonly y: FixedSide }) => void
  /** The crop being drawn changed. */
  readonly crop: (next: StudioRect) => void
  /** The draft, or the crop being drawn, moved on screen: its box in CSS pixels. */
  readonly placed: (box: Box) => void
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
type Grip = Handle | 'move' | 'draw'

/** Which way each handle pulls: -1 the start edge, 1 the end edge, 0 neither. */
const PULL: Record<Handle, readonly [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
}
const CORNERS: readonly Handle[] = ['nw', 'ne', 'se', 'sw']
const EDGES: readonly Handle[] = ['n', 'e', 's', 'w']
const CURSORS: Record<Grip, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  move: 'move',
  draw: 'crosshair',
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const OVERLAY_ID = 'caelestis-studio-frame'
/** Drawn size and hit size of a handle, in CSS pixels. Touch gets a finger-sized target. */
const KNOB_PX = 10
const HIT_PX = 24
const TOUCH_HIT_PX = 44
const ACCENT = 'rgb(30 144 255)'
const HALO = 'rgb(0 0 0 / 0.45)'
const DIM = 'rgb(0 0 0 / 0.55)'

let view: StudioFrameView | null = null
let handlers: StudioFrameHandlers | null = null
/** The box last reported to `handlers.placed`, so an unmoved map reports nothing. */
let placedAt: Box | null = null

interface Drag {
  readonly pointerId: number
  readonly grip: Grip
  readonly pointer: Point
  /** CSS pixels per canvas pixel when the drag began. */
  readonly scale: Point
  readonly view: StudioFrameView
  /** The canvas point the drag started at. */
  readonly start: Point
}
let drag: Drag | null = null

interface Overlay {
  readonly root: HTMLDivElement
  readonly svg: SVGSVGElement
  readonly image: SVGImageElement
  readonly dim: SVGPathElement
  readonly area: SVGRectElement
  readonly halo: SVGRectElement
  readonly line: SVGRectElement
  readonly knobs: Map<Handle, { readonly hit: SVGRectElement; readonly knob: SVGRectElement }>
  readonly label: HTMLDivElement
}
let overlay: Overlay | null = null

const svg = <K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

const hitSize = (): number =>
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    ? TOUCH_HIT_PX
    : HIT_PX

/**
 * Where the handles mount: beside the studio. Wplace's alliance editors are modal dialogs that
 * leave the rest of the page inert and cover it, so an alliance draft's handles go inside one.
 */
const overlayHost = (surface: TemplateSurface): HTMLElement =>
  (surface.kind === 'world'
    ? null
    : activeAllianceEditorStage()?.closest<HTMLElement>('dialog[open]')) ?? document.body

const ensureOverlay = (surface: TemplateSurface): Overlay => {
  const host = overlayHost(surface)
  if (overlay?.root.isConnected && overlay.root.parentElement === host) return overlay
  overlay?.root.remove()
  const root = document.createElement('div')
  root.id = OVERLAY_ID
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    // Above the map and its markers, below the studio's windows (31).
    zIndex: '18',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  const element = svg('svg', { width: '100%', height: '100%' })
  Object.assign(element.style, { position: 'absolute', inset: '0', overflow: 'visible' })
  element.setAttribute('aria-hidden', 'true')
  const image = svg('image', { preserveAspectRatio: 'none' })
  image.style.imageRendering = 'pixelated'
  const dim = svg('path', { fill: DIM, 'fill-rule': 'evenodd' })
  const area = svg('rect', { fill: 'transparent' })
  const halo = svg('rect', { fill: 'none', stroke: HALO, 'stroke-width': 3 })
  const line = svg('rect', { fill: 'none', stroke: ACCENT, 'stroke-width': 1.5 })
  element.append(image, dim, area, halo, line)
  const knobs = new Map<Handle, { hit: SVGRectElement; knob: SVGRectElement }>()
  for (const handle of [...CORNERS, ...EDGES]) {
    const hit = svg('rect', { fill: 'transparent' })
    const knob = svg('rect', {
      width: KNOB_PX,
      height: KNOB_PX,
      fill: '#fff',
      stroke: ACCENT,
      'stroke-width': 1.5,
    })
    knob.style.pointerEvents = 'none'
    hit.style.cursor = CURSORS[handle]
    hit.addEventListener('pointerdown', (event) => begin(event, handle))
    element.append(hit, knob)
    knobs.set(handle, { hit, knob })
  }
  dim.addEventListener('pointerdown', (event) => begin(event, 'draw'))
  dim.style.cursor = CURSORS.draw
  // A touch on any of these is a handle gesture, never a pan or pinch the browser may take over.
  // The root takes no pointer itself, so this reaches only touches that land on a handle part.
  for (const target of [element, dim, area, ...[...knobs.values()].map(({ hit }) => hit)])
    target.style.touchAction = 'none'
  area.addEventListener('pointerdown', (event) => begin(event, 'move'))
  area.style.cursor = CURSORS.move
  const label = document.createElement('div')
  Object.assign(label.style, {
    position: 'absolute',
    padding: '2px 6px',
    borderRadius: '4px',
    background: 'rgb(0 0 0 / 0.75)',
    color: '#fff',
    font: '600 12px/16px ui-sans-serif, system-ui, sans-serif',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    translate: '-50% 0',
    display: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  root.append(element, label)
  host.appendChild(root)
  overlay = { root, svg: element, image, dim, area, halo, line, knobs, label }
  return overlay
}

/* Geometry, in canvas pixels. */

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Canvas pixels per source pixel along each axis. */
const ratio = (frame: StudioFrameView): Point => ({
  x: frame.output.width / frame.crop.width,
  y: frame.output.height / frame.crop.height,
})

/** The whole source image laid out so its applied crop covers the draft. */
const sourceBox = (frame: StudioFrameView): Box => {
  const k = ratio(frame)
  return {
    x: frame.origin.x - frame.crop.x * k.x,
    y: frame.origin.y - frame.crop.y * k.y,
    width: frame.source.width * k.x,
    height: frame.source.height * k.y,
  }
}

/** A crop of the source, as a box on the canvas. */
const cropBox = (frame: StudioFrameView, crop: StudioRect): Box => {
  const k = ratio(frame)
  const image = sourceBox(frame)
  return {
    x: image.x + crop.x * k.x,
    y: image.y + crop.y * k.y,
    width: crop.width * k.x,
    height: crop.height * k.y,
  }
}

/** Every corner and edge, but a replacement keeps its size, and its crop its proportions. */
const handlesFor = (frame: StudioFrameView): readonly Handle[] => {
  if (!frame.locked) return [...CORNERS, ...EDGES]
  return frame.cropping === null ? [] : CORNERS
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** A crop from two opposite corners in source pixels, whole pixels inside the image. */
const cropBetween = (
  frame: StudioFrameView,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): StudioRect => {
  const { width, height } = frame.source
  const left = clamp(Math.round(Math.min(x0, x1)), 0, width - 1)
  const top = clamp(Math.round(Math.min(y0, y1)), 0, height - 1)
  const right = clamp(Math.round(Math.max(x0, x1)), left + 1, width)
  const bottom = clamp(Math.round(Math.max(y0, y1)), top + 1, height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

type Fixed = { readonly x: FixedSide; readonly y: FixedSide }

/** Where a side of `size` starts when the `side` of a box at `start`, `length` long, stays put. */
const placed = (side: FixedSide, start: number, length: number, size: number): number =>
  side === 'start' ? start : side === 'end' ? start + length - size : start + (length - size) / 2

/**
 * `from` with the sides `handle` pulls moved to `point`, at least `min` across. `lock` keeps its
 * proportions: a corner by whichever side the pointer pulls farther, an edge about its middle.
 * Within `bounds`, it stops at their edges, still in proportion when locked.
 */
const pulled = (
  from: Box,
  handle: Handle,
  point: Point,
  lock: boolean,
  min: number,
  bounds?: { readonly width: number; readonly height: number },
): { box: Box; fixed: Fixed } => {
  const [pullX, pullY] = PULL[handle]
  const right = from.x + from.width
  const bottom = from.y + from.height
  let width =
    pullX === 0 ? from.width : Math.max(min, pullX > 0 ? point.x - from.x : right - point.x)
  let height =
    pullY === 0 ? from.height : Math.max(min, pullY > 0 ? point.y - from.y : bottom - point.y)
  if (lock) {
    const scale =
      pullX !== 0 && pullY !== 0
        ? Math.max(width / from.width, height / from.height)
        : pullX !== 0
          ? width / from.width
          : height / from.height
    width = Math.max(min, from.width * scale)
    height = Math.max(min, from.height * scale)
  }
  const fixed: Fixed = {
    x: pullX > 0 ? 'start' : pullX < 0 ? 'end' : 'centre',
    y: pullY > 0 ? 'start' : pullY < 0 ? 'end' : 'centre',
  }
  if (bounds !== undefined) {
    const room = (side: FixedSide, start: number, length: number, limit: number): number =>
      side === 'start'
        ? limit - start
        : side === 'end'
          ? start + length
          : 2 * Math.min(start + length / 2, limit - start - length / 2)
    const roomX = room(fixed.x, from.x, from.width, bounds.width)
    const roomY = room(fixed.y, from.y, from.height, bounds.height)
    if (lock) {
      const fit = Math.min(1, roomX / width, roomY / height)
      width *= fit
      height *= fit
    } else {
      width = Math.min(width, roomX)
      height = Math.min(height, roomY)
    }
  }
  return {
    box: {
      x: placed(fixed.x, from.x, from.width, width),
      y: placed(fixed.y, from.y, from.height, height),
      width,
      height,
    },
    fixed,
  }
}

/** A box in whole pixels, at least one across. */
const whole = (box: Box): StudioRect => {
  const x = Math.round(box.x)
  const y = Math.round(box.y)
  return {
    x,
    y,
    width: Math.max(1, Math.round(box.x + box.width) - x),
    height: Math.max(1, Math.round(box.y + box.height) - y),
  }
}

/* Gestures. */

const begin = (event: PointerEvent, grip: Grip): void => {
  const frame = view
  if (frame === null || handlers === null || event.button !== 0 || drag !== null) return
  const scale = placementScale(frame.surface)
  if (scale === null || scale.x <= 0 || scale.y <= 0) return
  event.preventDefault()
  event.stopPropagation()
  listen(true)
  drag = {
    pointerId: event.pointerId,
    grip,
    pointer: { x: event.clientX, y: event.clientY },
    scale,
    view: frame,
    start:
      grip === 'move' || grip === 'draw'
        ? canvasPointAt(frame, event.clientX, event.clientY, scale)
        : handleAt(frame, grip),
  }
}

/**
 * Where `handle` sits on the canvas. A drag starts from here rather than from the pointer, so
 * grabbing anywhere in its hit target moves the edge by the pointer's travel, never jumping to it.
 */
const handleAt = (frame: StudioFrameView, handle: Handle): Point => {
  const box =
    frame.cropping === null ? { ...frame.origin, ...frame.output } : cropBox(frame, frame.cropping)
  const [pullX, pullY] = PULL[handle]
  return { x: box.x + (box.width * (pullX + 1)) / 2, y: box.y + (box.height * (pullY + 1)) / 2 }
}

/** The canvas point under a client point, from the draft's own projection. */
const canvasPointAt = (
  frame: StudioFrameView,
  clientX: number,
  clientY: number,
  scale: Point,
): Point => {
  const corner = placementScreenPoint(frame.surface, frame.origin.x, frame.origin.y) ?? {
    x: 0,
    y: 0,
  }
  return {
    x: frame.origin.x + (clientX - corner.x) / scale.x,
    y: frame.origin.y + (clientY - corner.y) / scale.y,
  }
}

/** The pointer's last place and whether Shift was down, so pressing Shift mid-drag redraws it. */
let last: { readonly x: number; readonly y: number; readonly shift: boolean } | null = null

const move = (event: PointerEvent): void => {
  if (drag === null || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  event.stopPropagation()
  last = { x: event.clientX, y: event.clientY, shift: event.shiftKey }
  apply()
}

/** Shift pressed or let go mid-drag switches between kept and free proportions at once. */
const onShift = (event: KeyboardEvent): void => {
  if (event.key !== 'Shift' || drag === null || last === null) return
  last = { ...last, shift: event.type === 'keydown' }
  apply()
}

/** Turn the drag so far into a size or a crop. */
const apply = (): void => {
  if (drag === null || last === null || handlers === null) return
  const { grip, view: frame, start } = drag
  // Screen travel over the scale the drag began at: the map does not move under a held handle.
  const point = {
    x: start.x + (last.x - drag.pointer.x) / drag.scale.x,
    y: start.y + (last.y - drag.pointer.y) / drag.scale.y,
  }
  if (frame.cropping === null) {
    if (grip === 'move' || grip === 'draw') return
    // Corners keep proportions and edges stretch; Shift swaps them.
    const lock = CORNERS.includes(grip) !== last.shift
    const { box, fixed } = pulled({ ...frame.origin, ...frame.output }, grip, point, lock, 1)
    handlers.resize(box, fixed)
  } else
    handlers.crop(cropTo(frame, frame.cropping, grip, start, point, last.shift || frame.locked))
  showLabel()
}

/** The crop a crop gesture makes, from where it began to `point`. */
const cropTo = (
  frame: StudioFrameView,
  from: StudioRect,
  grip: Grip,
  start: Point,
  point: Point,
  lock: boolean,
): StudioRect => {
  const k = ratio(frame)
  const image = sourceBox(frame)
  const at = { x: (point.x - image.x) / k.x, y: (point.y - image.y) / k.y }
  if (grip === 'draw') {
    const origin = { x: (start.x - image.x) / k.x, y: (start.y - image.y) / k.y }
    return cropBetween(frame, origin.x, origin.y, at.x, at.y)
  }
  if (grip === 'move') {
    const dx = Math.round((point.x - start.x) / k.x)
    const dy = Math.round((point.y - start.y) / k.y)
    return {
      ...from,
      x: clamp(from.x + dx, 0, frame.source.width - from.width),
      y: clamp(from.y + dy, 0, frame.source.height - from.height),
    }
  }
  return whole(pulled(from, grip, at, lock, 1, frame.source).box)
}

const end = (event: PointerEvent): void => {
  if (drag === null || event.pointerId !== drag.pointerId) return
  stop()
}

const stop = (): void => {
  drag = null
  last = null
  listen(false)
  if (overlay !== null) overlay.label.style.display = 'none'
}

/** A held handle follows the pointer wherever it goes, until it is released. */
const listen = (on: boolean): void => {
  if (on) {
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('keydown', onShift, true)
    window.addEventListener('keyup', onShift, true)
    window.addEventListener('blur', stop)
    return
  }
  window.removeEventListener('pointermove', move, true)
  window.removeEventListener('pointerup', end, true)
  window.removeEventListener('pointercancel', end, true)
  window.removeEventListener('keydown', onShift, true)
  window.removeEventListener('keyup', onShift, true)
  window.removeEventListener('blur', stop)
}

/** The size being made, under the box, while a handle is held. */
const showLabel = (): void => {
  if (overlay === null || view === null || last === null) return
  const box = view.cropping ?? { width: view.output.width, height: view.output.height }
  overlay.label.textContent = `${box.width} × ${box.height}`
  Object.assign(overlay.label.style, {
    display: 'block',
    left: `${last.x}px`,
    top: `${last.y + 22}px`,
  })
}

/* Drawing. */

const place = (
  element: SVGRectElement,
  box: { x: number; y: number; width: number; height: number },
): void => {
  element.setAttribute('x', String(box.x))
  element.setAttribute('y', String(box.y))
  element.setAttribute('width', String(Math.max(0, box.width)))
  element.setAttribute('height', String(Math.max(0, box.height)))
}

/** The box on screen, or null when the projection cannot place it. */
const onScreen = (frame: StudioFrameView, box: Box) => {
  const start = placementScreenPoint(frame.surface, box.x, box.y)
  const end = placementScreenPoint(frame.surface, box.x + box.width, box.y + box.height)
  if (start === null || end === null) return null
  return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y }
}

/** Redraw at the current projection. Runs every map frame and after every studio change. */
export const syncStudioFrame = (): void => {
  const frame = view
  if (frame === null) {
    overlay?.root.remove()
    overlay = null
    placedAt = null
    return
  }
  const parts = ensureOverlay(frame.surface)
  const cropping = frame.cropping
  const outline = onScreen(
    frame,
    cropping === null ? { ...frame.origin, ...frame.output } : cropBox(frame, cropping),
  )
  const image = cropping === null ? null : onScreen(frame, sourceBox(frame))
  // A map frame without tiles has no projection; the handles stay where the last one put them.
  if (outline === null) return
  if (
    placedAt === null ||
    placedAt.x !== outline.x ||
    placedAt.y !== outline.y ||
    placedAt.width !== outline.width ||
    placedAt.height !== outline.height
  ) {
    placedAt = outline
    handlers?.placed(outline)
  }
  place(parts.halo, outline)
  place(parts.line, outline)
  if (image === null) {
    parts.image.style.display = 'none'
    parts.dim.style.display = 'none'
    parts.area.style.display = 'none'
  } else {
    parts.image.style.display = ''
    parts.dim.style.display = ''
    parts.area.style.display = ''
    if (parts.image.getAttribute('href') !== frame.source.url)
      parts.image.setAttribute('href', frame.source.url)
    place(parts.image as unknown as SVGRectElement, image)
    const { x, y, width, height } = image
    parts.dim.setAttribute(
      'd',
      `M${x} ${y}h${width}v${height}h${-width}Z M${outline.x} ${outline.y}h${outline.width}v${outline.height}h${-outline.width}Z`,
    )
    place(parts.area, outline)
  }
  parts.dim.style.pointerEvents = image === null ? 'none' : 'auto'
  parts.area.style.pointerEvents = image === null ? 'none' : 'auto'
  const shown = new Set(handlesFor(frame))
  const hit = hitSize()
  for (const [handle, { hit: target, knob }] of parts.knobs) {
    const visible = shown.has(handle)
    target.style.display = visible ? '' : 'none'
    knob.style.display = visible ? '' : 'none'
    if (!visible) continue
    const [pullX, pullY] = PULL[handle]
    const cx = outline.x + (outline.width * (pullX + 1)) / 2
    const cy = outline.y + (outline.height * (pullY + 1)) / 2
    place(target, { x: cx - hit / 2, y: cy - hit / 2, width: hit, height: hit })
    target.style.pointerEvents = 'auto'
    place(knob, { x: cx - KNOB_PX / 2, y: cy - KNOB_PX / 2, width: KNOB_PX, height: KNOB_PX })
  }
}

/**
 * Where on the canvas `frame` reaches, and whether all of it is on screen: the whole source in
 * crop mode, the draft otherwise. Null while the map has not drawn a frame to measure against.
 */
export const studioFrameExtent = (frame: StudioFrameView): { box: Box; inView: boolean | null } => {
  const box = frame.cropping === null ? { ...frame.origin, ...frame.output } : sourceBox(frame)
  const shown = onScreen(frame, box)
  if (shown === null) return { box, inView: null }
  const inView =
    shown.x >= 0 &&
    shown.y >= 0 &&
    shown.x + shown.width <= window.innerWidth &&
    shown.y + shown.height <= window.innerHeight
  return { box, inView }
}

/** Show the studio's handles for `next`, or take them away with null. */
export const showStudioFrame = (next: StudioFrameView | null, on: StudioFrameHandlers): void => {
  view = next
  handlers = on
  if (next === null && drag !== null) stop()
  syncStudioFrame()
}
