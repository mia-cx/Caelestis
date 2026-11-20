import {
  anchorsOf,
  flattenPath,
  type PathNode,
  type Point,
  regionShapeBounds,
  regionShapeOutline,
  rubberBand,
  scaleBoxCorners,
} from '@caelestis/shared'
import { type EditorState, type Handle, ROTATE_CURSOR, selectedItem } from './claim-editor-state.js'
import type { ScreenProjection } from './coordinates.js'

/**
 * What claim mode draws over the map: every shape's outline, the handles of the one selected
 * shape, and whatever a gesture is drawing. `overlayMarks` describes it; `renderOverlay` puts it
 * in an SVG. Handles carry the `Handle` they edit, so a press needs no parsing.
 */

/** The overlay's element id; what is over it is over the map. */
export const CLAIM_OVERLAY_ID = 'caelestis-claim-overlay'
const HANDLE_RADIUS_CSS = 5
/** How far the rotate handle floats above the bounding box, in CSS pixels. */
const ROTATE_STEM_CSS = 26
const PEN_ANCHOR_SIZE = 7
const ACCENT = 'rgb(30 144 255)'
const FAINT = 'rgb(255 255 255 / 0.55)'
const GESTURE_FILL = 'rgb(30 144 255 / 0.12)'
const DASHED = '4 3'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** One SVG element to draw; a handle takes presses. */
export interface Mark {
  readonly tag: 'path' | 'line' | 'circle' | 'rect'
  readonly attributes: Readonly<Record<string, string | number>>
  readonly handle?: Handle
  readonly cursor?: string
}

const pathData = (points: readonly Point[], closed: boolean): string =>
  points.length === 0
    ? ''
    : `M${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('L')}${closed ? 'Z' : ''}`

const handleMark = (
  at: Point,
  handle: Handle,
  fill: string,
  radius = HANDLE_RADIUS_CSS,
  cursor = 'grab',
): Mark => ({
  tag: 'circle',
  attributes: { cx: at.x, cy: at.y, r: radius, fill, stroke: '#fff', 'stroke-width': 1.5 },
  handle,
  cursor,
})

const line = (from: Point, to: Point, attributes: Record<string, string | number> = {}): Mark => ({
  tag: 'line',
  attributes: { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: ACCENT, ...attributes },
})

/** The handles for the one selected shape, by tool. */
const handleMarks = (s: EditorState, project: (point: Point) => Point): Mark[] => {
  const item = selectedItem(s)
  if (item === null) return []
  const shape = item.shape
  const marks: Mark[] = []
  if (s.tool === 'select') {
    if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
      const corners = [
        { x: shape.x, y: shape.y },
        { x: shape.x + shape.w, y: shape.y },
        { x: shape.x + shape.w, y: shape.y + shape.h },
        { x: shape.x, y: shape.y + shape.h },
      ]
      for (const [index, corner] of corners.entries())
        marks.push(handleMark(project(corner), { kind: 'corner', index }, ACCENT))
    } else if (shape.kind === 'polygon' || shape.kind === 'star') {
      const ring = regionShapeOutline(shape)
      const outer = ring[0]
      if (outer !== undefined) marks.push(handleMark(project(outer), { kind: 'outer' }, ACCENT))
      if (shape.kind === 'star' && ring[1] !== undefined)
        marks.push(handleMark(project(ring[1]), { kind: 'inner' }, 'rgb(255 160 40)'))
    } else {
      // A path or a drawing: Illustrator's bounding box, with a scale handle on each corner.
      const corners = scaleBoxCorners(shape).map(project)
      marks.push({
        tag: 'path',
        attributes: {
          d: pathData(corners, true),
          fill: 'none',
          stroke: ACCENT,
          'stroke-width': 1,
          'stroke-dasharray': '3 3',
          'data-gesture': 'bounds',
        },
      })
      for (const [index, corner] of corners.entries())
        marks.push(handleMark(corner, { kind: 'scale', index }, ACCENT))
    }
    // A rotate handle floats above the box; the zones just outside its corners rotate too.
    const box = regionShapeBounds(shape)
    const top = project({ x: box.x + box.w / 2, y: box.y })
    const grip = { x: top.x, y: top.y - ROTATE_STEM_CSS }
    marks.push(line(top, grip, { 'stroke-width': 1 }))
    marks.push(
      handleMark(grip, { kind: 'rotate' }, 'rgb(120 200 90)', HANDLE_RADIUS_CSS, ROTATE_CURSOR),
    )
  }
  const anchorTool =
    s.tool === 'direct' ||
    s.tool === 'anchor' ||
    s.tool === 'add-anchor' ||
    s.tool === 'delete-anchor' ||
    (s.tool === 'pen' && s.pen === null)
  if (!anchorTool) return marks
  if (shape.kind !== 'path') {
    // Every shape has anchors under direct selection; dragging one makes it a path.
    for (const [index, anchor] of anchorsOf(shape).entries())
      marks.push(handleMark(project(anchor), { kind: 'anchor', index }, ACCENT))
    return marks
  }
  shape.nodes.forEach((node, index) => {
    const anchor = project(node)
    for (const part of ['in', 'out'] as const) {
      const control = node[part]
      if (control === undefined) continue
      const at = project(control)
      marks.push(line(anchor, at, { 'stroke-width': 1 }))
      marks.push(handleMark(at, { kind: 'node', index, part }, '#fff', HANDLE_RADIUS_CSS - 1))
    }
    marks.push(handleMark(anchor, { kind: 'node', index, part: 'anchor' }, ACCENT))
  })
  return marks
}

/** The pen path so far as the curve it is, with every anchor and handle, as any vector editor. */
const penMarks = (s: EditorState, pen: readonly PathNode[], project: (point: Point) => Point) => {
  const marks: Mark[] = [
    {
      tag: 'path',
      attributes: {
        d: pathData(flattenPath(pen, false).map(project), false),
        fill: 'none',
        stroke: ACCENT,
        'stroke-width': 1.5,
      },
    },
  ]
  const last = pen[pen.length - 1] as PathNode
  if (s.hover !== null && s.drag === null)
    // The rubber band: where the next segment would go from the last anchor.
    marks.push({
      tag: 'path',
      attributes: {
        d: pathData(rubberBand(last, s.hover).map(project), false),
        fill: 'none',
        stroke: ACCENT,
        'stroke-width': 1,
        'stroke-dasharray': '3 3',
        'data-gesture': 'rubber-band',
      },
    })
  pen.forEach((node, index) => {
    const anchor = project(node)
    for (const part of ['in', 'out'] as const) {
      const control = node[part]
      if (control === undefined) continue
      const at = project(control)
      marks.push(line(anchor, at))
      marks.push({
        tag: 'circle',
        attributes: { cx: at.x, cy: at.y, r: 3, fill: '#fff', stroke: ACCENT },
      })
    }
    marks.push({
      tag: 'rect',
      attributes: {
        x: anchor.x - PEN_ANCHOR_SIZE / 2,
        y: anchor.y - PEN_ANCHOR_SIZE / 2,
        width: PEN_ANCHOR_SIZE,
        height: PEN_ANCHOR_SIZE,
        fill: index === pen.length - 1 ? ACCENT : '#fff',
        stroke: ACCENT,
        'stroke-width': 1.5,
        'data-pen-anchor': index,
      },
    })
  })
  return marks
}

/** Outlines and handles for the current document at the current projection. */
export const overlayMarks = (s: EditorState, projection: ScreenProjection): Mark[] => {
  const project = (point: Point): Point => projection.pointFor(point.x, point.y)
  const marks: Mark[] = s.items.map((item) => {
    const selected = s.selectedIds.includes(item.id)
    return {
      tag: 'path',
      attributes: {
        d: pathData(
          regionShapeOutline(item.shape).map(project),
          item.shape.kind !== 'path' || item.shape.closed,
        ),
        fill: 'none',
        stroke: selected ? ACCENT : FAINT,
        'stroke-width': selected ? 1.5 : 1,
        'stroke-dasharray': item.op === 'subtract' ? DASHED : '0',
      },
    }
  })
  marks.push(...handleMarks(s, project))
  // Selection gestures show what they cover: a dashed box or loop, with the caught shapes lit.
  if (s.marquee !== null) {
    const { x0, y0, x1, y1 } = s.marquee
    const a = project({ x: Math.min(x0, x1), y: Math.min(y0, y1) })
    const b = project({ x: Math.max(x0, x1), y: Math.max(y0, y1) })
    marks.push({
      tag: 'rect',
      attributes: {
        x: a.x,
        y: a.y,
        width: Math.max(0, b.x - a.x),
        height: Math.max(0, b.y - a.y),
        fill: GESTURE_FILL,
        stroke: ACCENT,
        'stroke-width': 1,
        'stroke-dasharray': DASHED,
        'data-gesture': 'marquee',
      },
    })
  }
  if (s.lasso !== null && s.lasso.length > 1)
    marks.push({
      tag: 'path',
      attributes: {
        d: pathData(s.lasso.map(project), true),
        fill: GESTURE_FILL,
        stroke: ACCENT,
        'stroke-width': 1,
        'stroke-dasharray': DASHED,
        'data-gesture': 'lasso',
      },
    })
  // What is mid-gesture gets an outline too, so a shape is visible while it is being dragged out.
  if (s.drawing !== null)
    marks.push({
      tag: 'path',
      attributes: {
        d: pathData(regionShapeOutline(s.drawing).map(project), true),
        fill: 'none',
        stroke: ACCENT,
        'stroke-width': 1.5,
        'stroke-dasharray': s.settings.subtract ? DASHED : '0',
      },
    })
  if (s.erasing !== null && s.erasing.line.length > 1)
    marks.push({
      tag: 'path',
      attributes: {
        d: pathData(s.erasing.line.map(project), false),
        fill: 'none',
        stroke: 'rgb(255 90 90)',
        'stroke-width': 1.5,
        'stroke-dasharray': DASHED,
        'stroke-linecap': 'round',
        'data-gesture': 'erase',
      },
    })
  if (s.stroke !== null && s.stroke.length > 1)
    marks.push({
      tag: 'path',
      attributes: {
        d: pathData(s.stroke.map(project), false),
        fill: 'none',
        stroke: ACCENT,
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
      },
    })
  if (s.pen !== null && s.pen.length > 0) marks.push(...penMarks(s, s.pen, project))
  return marks
}

const handles = new WeakMap<Element, Handle>()

/** The handle a pressed element is, if it is one. */
export const handleOf = (target: EventTarget | null): Handle | undefined =>
  target instanceof Element ? handles.get(target) : undefined

/** Replace the overlay's contents with these marks. */
export const renderOverlay = (root: SVGSVGElement, marks: readonly Mark[]): void => {
  root.replaceChildren(
    ...marks.map((mark) => {
      const element = document.createElementNS(SVG_NS, mark.tag)
      for (const [key, value] of Object.entries(mark.attributes))
        element.setAttribute(key, String(value))
      if (mark.handle !== undefined) {
        handles.set(element, mark.handle)
        element.style.pointerEvents = 'auto'
        element.style.cursor = mark.cursor ?? 'grab'
      }
      return element
    }),
  )
}
