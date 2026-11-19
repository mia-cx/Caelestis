import {
  boxShape,
  claimDocumentPixels,
  claimDocuments,
  claimDocumentsLimitError,
  claimSet,
  cornerAnchor,
  documentLimitError,
  eraseFromRaster,
  inLasso,
  inMarquee,
  insertAnchor,
  isSmooth,
  MAX_PATH_NODES,
  mergeRasters,
  moveNode,
  nearestOnPath,
  orientToContinue,
  type PathHit,
  type PathNode,
  type PathShape,
  PixelSet,
  type Point,
  type PresenceRect,
  type RegionDocument,
  type RegionItem,
  type RegionShape,
  type RegionShapePixels,
  rasterTouches,
  regionDocumentBounds,
  regionShapeBounds,
  regionShapeCentre,
  regionShapeContainsPixel,
  removeAnchor,
  rotateShape,
  roundShape,
  scaleBoxCorners,
  scaleShape,
  selectionError,
  smoothAnchor,
  starInner,
  toPath,
  translateRegionShape,
  uuidV7,
  worldPixel,
} from '@caelestis/shared'
import {
  type ClaimModeModel,
  type ClaimOption,
  type ClaimPurpose,
  type ClaimTool,
  type ClaimToolGroupId,
  claimToolEntry,
  clampClaimOption,
} from '@caelestis/ui/elements'
import { splitItem, strokeArea } from './claim-split.js'
import type { ScreenProjection } from './coordinates.js'
import { CLICK_SLOP_PX } from './map-pointer.js'

/**
 * Claim mode's editor without the page: the working document, the tool in hand, and what each
 * pointer gesture or option does to them. The DOM shell (`claim-editor.ts`) turns events into
 * these calls and draws the result; nothing here touches the document or the window.
 *
 * A claim is a document of shapes, each adding to or cutting from the claimed pixels, and every
 * shape stays editable. Tools follow Illustrator: selection (click, Shift-click to add, drag to
 * move, drag empty canvas for a marquee, handles to resize or rotate), direct selection (anchors
 * and bezier handles of a path), lasso, pen (click for corners, drag for curves, click the first
 * anchor to close), pencil and paintbrush, eraser, rectangle, ellipse, polygon and star, and the
 * hand, the one tool that leaves a drag to the map. Everything the tools produce is whole pixels
 * once rasterised, because the shared rasteriser decides membership by pixel centre.
 *
 * Capture mode is the same editor with another purpose: the whole document is one selection
 * mask for art to capture. Update mode is capture mode aimed at an existing template.
 */

/** Hit radius around handles and paths, in CSS pixels. */
export const HIT_RADIUS_CSS = 9
const STROKE_STEP_PX = 2
/** Just outside a bounding-box corner, this far in CSS pixels, the pointer rotates the shape. */
const ROTATE_ZONE_CSS = 28
/** Illustrator's Shift while rotating: whole turns of this many degrees. */
const ROTATE_SNAP_DEGREES = 15
const DEFAULT_INNER = 50
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M10 3a7 7 0 1 1-6.3 4" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M10 3a7 7 0 1 1-6.3 4" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round"/><path d="M3 2v5.5h5.5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/><path d="M3 2v5.5h5.5" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>',
)}") 10 10, alias`

/** A handle the overlay draws on the one selected shape, and what a press on it edits. */
export type Handle =
  /** A rectangle's or ellipse's corner, 0 top left, clockwise. */
  | { readonly kind: 'corner'; readonly index: number }
  /** A polygon's or star's outer radius, and a star's inner one. */
  | { readonly kind: 'outer' }
  | { readonly kind: 'inner' }
  /** A corner of a path's or raster's bounding box. */
  | { readonly kind: 'scale'; readonly index: number }
  | { readonly kind: 'rotate' }
  /** A path anchor or one of its bezier handles. */
  | { readonly kind: 'node'; readonly index: number; readonly part: NodePart }
  /** An anchor of a shape that is not a path yet. */
  | { readonly kind: 'anchor'; readonly index: number }

export type NodePart = 'anchor' | 'in' | 'out'

type DragKind =
  | 'draw'
  | 'move'
  | 'corner'
  | 'outer'
  | 'inner'
  | 'node'
  | 'stroke'
  | 'pen'
  | 'marquee'
  | 'lasso'
  | 'rotate'
  | 'raster'
  | 'erase'
  | 'scale'
  | 'handle-solo'
  | 'anchor-pull'
  | 'anchor-convert'

interface Drag {
  kind: DragKind
  readonly pointerId: number
  readonly origin: Point
  readonly client: Point
  /** The item as it was when the gesture began. */
  base: RegionItem | null
  /** For move drags: every selected item as it was, so they travel together. */
  readonly group: readonly RegionItem[]
  /** Which corner or node the gesture holds. */
  readonly index: number
  readonly part: NodePart
  /** Where the press landed, in canvas coordinates, for angles measured from the origin. */
  readonly press: Point
  moved: boolean
}

/** One pointer event as the editor needs it: where on screen, and where on the canvas. */
export interface PointerInput {
  readonly pointerId: number
  readonly client: Point
  /** The canvas point under the pointer, fractional, or null off the map. */
  readonly point: Point | null
  readonly shiftKey: boolean
}

/** Tool options that outlive a session. */
export interface ToolSettings {
  sides: number
  points: number
  inner: number
  width: number
  /** The pencil's tip and the eraser's, in pixels; each tool keeps its own. */
  pencilWidth: number
  eraserWidth: number
  subtract: boolean
}

export const defaultToolSettings = (): ToolSettings => ({
  sides: 6,
  points: 5,
  inner: DEFAULT_INNER,
  width: 8,
  pencilWidth: 1,
  eraserWidth: 8,
  subtract: false,
})

export interface EditorPixels {
  readonly rect: PresenceRect
  readonly count: number
  readonly parts: readonly RegionShapePixels[]
}

/** The document as it would be saved now, with what stands in the way. */
interface Derived {
  readonly version: number
  /** The claims a save writes; a capture selection is one document. */
  readonly documents: readonly RegionDocument[]
  readonly pixels: EditorPixels | null
  readonly error: string | null
}

export interface EditorState {
  readonly purpose: ClaimPurpose
  readonly settings: ToolSettings
  tool: ClaimTool
  items: RegionItem[]
  /** Selected item ids, in selection order. Handles appear only for a selection of one. */
  selectedIds: readonly string[]
  shown: Record<ClaimToolGroupId, ClaimTool>
  /** A marquee being dragged, in canvas pixels, and a lasso being drawn. */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
  lasso: Point[] | null
  /** What was selected before a Shift-marquee or Shift-lasso began, to add to. */
  baseSelection: readonly string[]
  /** The tool to return to when the space bar, held for a temporary hand, is released. */
  handHeldFrom: ClaimTool | null
  /** The saved claims loaded into the editor; Save writes the set back under these and new ids. */
  editingIds: readonly string[]
  drag: Drag | null
  /** The pen path under construction. */
  pen: PathNode[] | null
  /** When the pen continues a saved path, the item it came from and its slot, restored on commit. */
  penContinued: { readonly item: RegionItem; readonly index: number } | null
  /** Where the pointer is over the map, for the pen's rubber band. */
  hover: Point | null
  /** A brush stroke under construction, as raw points. */
  stroke: Point[] | null
  /** The shape under construction with a shape tool. */
  drawing: RegionShape | null
  /** The pixels the pencil has laid down so far in this stroke. */
  raster: PixelSet | null
  /** What the eraser has covered so far: the pixels, and the path for cutting vector shapes. */
  erasing: { readonly set: PixelSet; line: Point[] } | null
  /** The last pixel a pencil or eraser stamped, so a fast move still leaves an unbroken line. */
  lastStamp: Point | null
  /** A save or capture is in flight with a snapshot of the document. */
  pending: boolean
  message: string | undefined
  /** Whether the working document differs from what was loaded or saved. */
  dirty: boolean
  cursor: string
  /** Bumped on every change to what is drawn, so derived pixels are cached per change. */
  version: number
  derived: Derived | null
}

const defaultShown = (): Record<ClaimToolGroupId, ClaimTool> => ({
  selection: 'select',
  pen: 'pen',
  pencil: 'pencil',
  shape: 'rectangle',
  navigate: 'hand',
})

export const isSelectionTool = (of: ClaimTool): boolean => of === 'select' || of === 'direct'

export const toolCursor = (of: ClaimTool): string =>
  isSelectionTool(of) ? 'default' : of === 'hand' ? 'grab' : of === 'pen' ? 'copy' : 'crosshair'

const nextItemId = (): string => uuidV7()

/**
 * A new session over `saved` claims, empty for a capture. Claims saved separately may reuse item
 * ids; every item gets its own here, or a later edit could address the wrong one and the written
 * documents would be refused.
 */
export const openEditor = (
  purpose: ClaimPurpose,
  tool: ClaimTool,
  saved: readonly { readonly id: string; readonly document: RegionDocument }[],
  settings: ToolSettings,
): EditorState => {
  const seen = new Set<string>()
  const items = saved
    .flatMap((region) => region.document.items)
    .map((item) => {
      const unique = seen.has(item.id) ? { ...item, id: nextItemId() } : item
      seen.add(unique.id)
      return unique
    })
  const grouped = claimDocuments({ items })
  return {
    purpose,
    settings,
    tool,
    items,
    selectedIds: [],
    shown: { ...defaultShown(), [claimToolEntry(tool).group]: tool },
    marquee: null,
    lasso: null,
    baseSelection: [],
    handHeldFrom: null,
    editingIds: saved.map((region) => region.id),
    drag: null,
    pen: null,
    penContinued: null,
    hover: null,
    stroke: null,
    drawing: null,
    raster: null,
    erasing: null,
    lastStamp: null,
    pending: false,
    message: claimDocumentsLimitError(grouped) ?? undefined,
    // Existing claims may now join or split without a gesture. Save must persist that grouping.
    dirty:
      grouped.length !== saved.length ||
      saved.some((region) => claimDocuments(region.document).length > 1),
    cursor: toolCursor(tool),
    version: 0,
    derived: null,
  }
}

const bump = (s: EditorState): void => {
  s.version++
}

/** Any change to the items themselves; previews and selection do not count. */
const touch = (s: EditorState): void => {
  s.dirty = true
  bump(s)
}

const op = (s: EditorState): RegionItem['op'] => (s.settings.subtract ? 'subtract' : 'add')

const isSelected = (s: EditorState, id: string): boolean => s.selectedIds.includes(id)

/** The one selected item, when exactly one is: what handles and option edits apply to. */
export const selectedItem = (s: EditorState): RegionItem | null =>
  s.selectedIds.length === 1 ? (s.items.find((item) => item.id === s.selectedIds[0]) ?? null) : null

const select = (s: EditorState, ids: readonly string[]): void => {
  s.selectedIds = [...new Set(ids)]
}

const replaceItem = (s: EditorState, id: string, shape: RegionShape): void => {
  s.items = s.items.map((item) => (item.id === id ? { ...item, shape } : item))
  touch(s)
}

const restoreItems = (s: EditorState, originals: readonly RegionItem[]): void => {
  s.items = s.items.map((item) => originals.find((was) => was.id === item.id) ?? item)
}

const limitError = (s: EditorState, document: RegionDocument): string | null =>
  documentLimitError(document, s.purpose === 'claim' ? 'claim' : 'selection')

const addItem = (s: EditorState, shape: RegionShape): void => {
  const item: RegionItem = { id: nextItemId(), shape, op: op(s) }
  const error = limitError(s, { items: [...s.items, item] })
  if (error !== null) {
    s.message = error
    return
  }
  s.items = [...s.items, item]
  select(s, [item.id])
  touch(s)
}

/** The shape being drawn right now, as a temporary item, so previews rasterise like the rest. */
const previewItem = (s: EditorState): RegionItem | null => {
  const preview = (shape: RegionShape, cut = s.settings.subtract): RegionItem => ({
    id: 'preview',
    shape,
    op: cut ? 'subtract' : 'add',
  })
  const width = Math.max(1, s.settings.width)
  if (s.drawing !== null) return preview(s.drawing)
  const drawn = s.raster?.shape() ?? null
  if (drawn !== null) return preview(drawn)
  if (s.erasing !== null && s.erasing.line.length >= 1) {
    // What the eraser will take is shown taken while it moves.
    const line =
      s.erasing.line.length === 1 ? [...s.erasing.line, ...s.erasing.line] : s.erasing.line
    return preview(
      { kind: 'path', closed: false, width: s.settings.eraserWidth, nodes: line },
      true,
    )
  }
  if (s.stroke !== null && s.stroke.length >= 2)
    return preview({ kind: 'path', closed: false, width, nodes: s.stroke })
  if (s.pen !== null && s.pen.length >= 2)
    return preview({ kind: 'path', closed: false, width, nodes: s.pen })
  return null
}

/**
 * The claim as pixels and documents, including whatever is mid-gesture: one bounded raster per
 * independent group of touching shapes, so empty space between distant shapes is never
 * rasterised. A capture selection rasterises as one. Cached per change.
 */
export const derive = (s: EditorState): Derived => {
  if (s.derived?.version === s.version) return s.derived
  const preview = previewItem(s)
  const document = { items: preview === null ? s.items : [...s.items, preview] }
  const capture = s.purpose !== 'claim'
  const { documents, error } = capture
    ? { documents: [document], error: selectionError(document) }
    : claimSet(document)
  const parts =
    capture && error !== null
      ? []
      : documents.flatMap((part) => {
          const pixels = claimDocumentPixels(part)
          return pixels === null || pixels.count === 0 ? [] : [pixels]
        })
  const rect = regionDocumentBounds(document)
  s.derived = {
    version: s.version,
    documents,
    error,
    pixels:
      rect === null
        ? null
        : { rect, parts, count: parts.reduce((count, part) => count + part.count, 0) },
  }
  return s.derived
}

/** What the mode element shows. */
export const editorModel = (s: EditorState, template: string | null): ClaimModeModel => {
  const { pixels, error } = derive(s)
  const status = s.message ?? error
  const values: Record<ClaimOption, number> = {
    sides: s.settings.sides,
    points: s.settings.points,
    inner: s.settings.inner,
    width: widthOf(s.settings, s.tool),
  }
  return {
    purpose: s.purpose,
    tool: s.tool,
    shown: s.shown,
    options: Object.fromEntries(
      claimToolEntry(s.tool).options.map((option) => [option, values[option]]),
    ),
    subtract: s.settings.subtract,
    items: s.items.length,
    selected: s.selectedIds.length > 0,
    selectedCount: s.selectedIds.length,
    dirty: s.dirty,
    template,
    pixels: pixels?.count ?? 0,
    pending: s.pending,
    ...(status === null ? {} : { message: status }),
  }
}

const widthOf = (settings: ToolSettings, of: ClaimTool): number =>
  of === 'pencil' ? settings.pencilWidth : of === 'eraser' ? settings.eraserWidth : settings.width

/** Topmost item whose pixels contain the canvas pixel. */
const itemAt = (s: EditorState, px: number, py: number): RegionItem | null => {
  for (let index = s.items.length - 1; index >= 0; index--) {
    const item = s.items[index] as RegionItem
    if (regionShapeContainsPixel(item.shape, px, py)) return item
  }
  return null
}

/** Canvas pixels per CSS pixel of hit radius, so hit tests scale with the zoom. */
const hitRadiusCanvas = (projection: ScreenProjection | null): number =>
  HIT_RADIUS_CSS / Math.max(projection?.pixelsPerCanvasPixel.x ?? 1, 1e-6)

/** The topmost item whose outline passes within reach of a canvas point, as a path. */
const pathNear = (
  s: EditorState,
  point: Point,
  projection: ScreenProjection | null,
): { readonly item: RegionItem; readonly path: PathShape; readonly hit: PathHit } | null => {
  const radius = hitRadiusCanvas(projection)
  for (let index = s.items.length - 1; index >= 0; index--) {
    const item = s.items[index] as RegionItem
    if (item.shape.kind === 'pixels') continue
    const path = toPath(item.shape)
    const hit = nearestOnPath(path.nodes, path.closed, point)
    if (hit !== null && hit.distance <= radius) return { item, path, hit }
  }
  return null
}

/** Make an item a path in place (a no-op for one already), returning the path. */
const ensurePath = (s: EditorState, item: RegionItem): PathShape => {
  if (item.shape.kind === 'path') return item.shape
  const path = toPath(item.shape)
  replaceItem(s, item.id, path)
  return path
}

const pathFullMessage = `A path holds at most ${MAX_PATH_NODES} anchors.`

const addAnchorAt = (
  s: EditorState,
  point: Point,
  projection: ScreenProjection | null,
): boolean => {
  const near = pathNear(s, point, projection)
  if (near === null) return false
  if (near.path.nodes.length >= MAX_PATH_NODES) {
    s.message = pathFullMessage
    return true
  }
  ensurePath(s, near.item)
  replaceItem(s, near.item.id, {
    ...near.path,
    nodes: insertAnchor(near.path.nodes, near.hit.index, near.hit.t),
  })
  select(s, [near.item.id])
  return true
}

/** Remove one anchor of an item; a path left too short goes altogether. */
const deleteAnchorOf = (s: EditorState, item: RegionItem, index: number): void => {
  const path = ensurePath(s, item)
  const nodes = removeAnchor(path.nodes, index)
  if (nodes.length < (path.closed ? 3 : 2)) {
    s.items = s.items.filter((held) => held.id !== item.id)
    select(s, [])
    touch(s)
    return
  }
  replaceItem(s, item.id, { ...path, nodes })
}

/** The pen picks up an open path at one of its ends. */
const continuePathFrom = (s: EditorState, item: RegionItem, index: number): boolean => {
  if (item.shape.kind !== 'path' || item.shape.closed) return false
  if (index !== 0 && index !== item.shape.nodes.length - 1) return false
  s.pen = orientToContinue(item.shape.nodes, index)
  s.penContinued = { item, index: s.items.indexOf(item) }
  s.items = s.items.filter((held) => held.id !== item.id)
  select(s, [])
  bump(s)
  return true
}

/** Put the path the pen continued back where it was: add and subtract apply in order. */
const restoreContinued = (s: EditorState, item: RegionItem): void => {
  const at = Math.min(s.penContinued?.index ?? 0, s.items.length)
  s.items = [...s.items.slice(0, at), item, ...s.items.slice(at)]
}

/** Finish the pen path, closed or open. Too short a path is dropped. */
export const commitPen = (s: EditorState, closed: boolean): void => {
  if (s.pen === null) return
  const nodes = s.pen
  const continued = s.penContinued?.item ?? null
  s.pen = null
  if (nodes.length < (closed ? 3 : 2)) {
    if (continued !== null) restoreContinued(s, continued)
    s.penContinued = null
    bump(s)
    return
  }
  if (continued !== null && continued.shape.kind === 'path') {
    // The path picks up where it left off, under its own id, width, and place in the order.
    restoreContinued(s, { ...continued, shape: { ...continued.shape, closed, nodes } })
    s.penContinued = null
    select(s, [continued.id])
    touch(s)
    return
  }
  s.penContinued = null
  addItem(s, {
    kind: 'path',
    closed,
    width: closed ? s.settings.width : Math.max(1, s.settings.width),
    nodes,
  })
}

/** Drop the pen path; a continued path goes back as it was. */
export const dropPen = (s: EditorState): void => {
  s.pen = null
  if (s.penContinued !== null) restoreContinued(s, s.penContinued.item)
  s.penContinued = null
  bump(s)
}

/** Build the shape-tool shape from the press pixel and the pointer pixel. */
const shapeFrom = (s: EditorState, origin: Point, at: Point): RegionShape | null => {
  switch (s.tool) {
    case 'rectangle':
    case 'ellipse':
      return boxShape(s.tool, origin, at)
    case 'polygon':
    case 'star':
      return roundShape(s.tool, origin, at, s.settings)
    default:
      return null
  }
}

/** The bounding-box corners of a shape, projected to client pixels. */
const cornersOnScreen = (shape: RegionShape, projection: ScreenProjection): Point[] => {
  const box = regionShapeBounds(shape)
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((corner) => projection.pointFor(corner.x, corner.y))
}

/**
 * Whether a client point sits in a rotate zone: just outside a bounding-box corner of the one
 * selected shape, past the corner's own handle, as Illustrator's cursor does near a corner.
 */
const inRotateZone = (
  s: EditorState,
  client: Point,
  projection: ScreenProjection | null,
): boolean => {
  const item = selectedItem(s)
  if (item === null || s.tool !== 'select' || projection === null) return false
  const corners = cornersOnScreen(item.shape, projection)
  const [a, , c] = corners
  if (a === undefined || c === undefined) return false
  const insideBox =
    client.x >= Math.min(a.x, c.x) - HIT_RADIUS_CSS &&
    client.x <= Math.max(a.x, c.x) + HIT_RADIUS_CSS &&
    client.y >= Math.min(a.y, c.y) - HIT_RADIUS_CSS &&
    client.y <= Math.max(a.y, c.y) + HIT_RADIUS_CSS
  if (insideBox) return false
  return corners.some(
    (corner) => Math.hypot(client.x - corner.x, client.y - corner.y) <= ROTATE_ZONE_CSS,
  )
}

const startDrag = (
  s: EditorState,
  kind: DragKind,
  input: PointerInput,
  origin: Point,
  base: RegionItem | null,
  index = 0,
  part: NodePart = 'anchor',
): void => {
  s.drag = {
    kind,
    pointerId: input.pointerId,
    origin,
    client: input.client,
    base,
    group: kind === 'move' ? s.items.filter((item) => isSelected(s, item.id)) : [],
    index,
    part,
    press: input.point ?? origin,
    moved: false,
  }
}

const NO_POINT: Point = { x: 0, y: 0 }

/** A press on one of the overlay's handles. Handles only exist on the one selected shape. */
export const pressHandle = (s: EditorState, handle: Handle, input: PointerInput): void => {
  const item = selectedItem(s)
  if (item === null) return
  const shape = item.shape
  s.message = undefined
  switch (handle.kind) {
    case 'corner':
      if (shape.kind !== 'rectangle' && shape.kind !== 'ellipse') return
      // The opposite corner stays put.
      startDrag(
        s,
        'corner',
        input,
        {
          x: handle.index === 1 || handle.index === 2 ? shape.x : shape.x + shape.w - 1,
          y: handle.index === 2 || handle.index === 3 ? shape.y : shape.y + shape.h - 1,
        },
        item,
        handle.index,
      )
      return
    case 'outer':
    case 'inner':
      if (shape.kind !== 'polygon' && shape.kind !== 'star') return
      startDrag(s, handle.kind, input, { x: shape.cx, y: shape.cy }, item)
      return
    case 'rotate':
      startDrag(s, 'rotate', input, regionShapeCentre(shape), item)
      return
    case 'scale':
      if (shape.kind !== 'path' && shape.kind !== 'pixels') return
      // The opposite corner of the bounding box stays put.
      startDrag(
        s,
        'scale',
        input,
        scaleBoxCorners(shape)[(handle.index + 2) % 4] as Point,
        item,
        handle.index,
      )
      return
    case 'node':
      if (shape.kind !== 'path') return
      pressNode(s, item, handle.index, handle.part, input)
      return
    case 'anchor':
      if (shape.kind === 'path') return
      if (s.tool === 'delete-anchor') deleteAnchorOf(s, item, handle.index)
      else if (s.tool === 'anchor') {
        const converted: RegionItem = { ...item, shape: toPath(shape) }
        replaceItem(s, item.id, converted.shape)
        startDrag(s, 'anchor-pull', input, NO_POINT, converted, handle.index)
      }
      // Editing one anchor of a rectangle, ellipse, polygon, or star turns it into a path, but
      // only once the anchor moves: a mere click must leave the claim as it was.
      else startDrag(s, 'anchor-convert', input, NO_POINT, item, handle.index)
  }
}

const pressNode = (
  s: EditorState,
  item: RegionItem,
  index: number,
  part: NodePart,
  input: PointerInput,
): void => {
  switch (s.tool) {
    case 'pen':
      // The pen on a selected path: continue from an end, otherwise delete the anchor.
      if (!continuePathFrom(s, item, index)) deleteAnchorOf(s, item, index)
      return
    case 'delete-anchor':
      if (part === 'anchor') deleteAnchorOf(s, item, index)
      return
    case 'add-anchor':
      // Segments are hit on the map; an anchor has nothing to add.
      return
    case 'anchor':
      startDrag(
        s,
        part === 'anchor' ? 'anchor-pull' : 'handle-solo',
        input,
        NO_POINT,
        item,
        index,
        part,
      )
      return
    default:
      startDrag(s, 'node', input, NO_POINT, item, index, part)
  }
}

/**
 * A press on the map with the tool in hand. False when the press is left to the map: the hand,
 * or a point off the canvas.
 */
export const pressMap = (
  s: EditorState,
  input: PointerInput,
  projection: ScreenProjection | null,
): boolean => {
  const point = input.point
  if (point === null) return false
  const pixel = { x: worldPixel(point.x), y: worldPixel(point.y) }
  s.message = undefined
  const item = selectedItem(s)
  if (item !== null && inRotateZone(s, input.client, projection)) {
    startDrag(s, 'rotate', input, regionShapeCentre(item.shape), item)
    return true
  }
  switch (s.tool) {
    case 'select':
    case 'direct': {
      const hit = itemAt(s, pixel.x, pixel.y)
      if (hit === null) {
        // Empty canvas: drag out a marquee. Shift adds to what is selected, as in Illustrator.
        s.baseSelection = input.shiftKey ? s.selectedIds : []
        select(s, s.baseSelection)
        s.marquee = { x0: point.x, y0: point.y, x1: point.x, y1: point.y }
        startDrag(s, 'marquee', input, pixel, null)
        return true
      }
      // Shift toggles membership; a press on an already selected shape keeps the whole selection
      // so the drag moves all of it; anything else selects just this shape.
      if (input.shiftKey)
        select(
          s,
          isSelected(s, hit.id)
            ? s.selectedIds.filter((id) => id !== hit.id)
            : [...s.selectedIds, hit.id],
        )
      else if (!isSelected(s, hit.id) || s.tool === 'direct') select(s, [hit.id])
      if (s.tool === 'select' && isSelected(s, hit.id)) startDrag(s, 'move', input, pixel, hit)
      return true
    }
    case 'lasso':
      s.baseSelection = input.shiftKey ? s.selectedIds : []
      select(s, s.baseSelection)
      s.lasso = [{ x: point.x, y: point.y }]
      startDrag(s, 'lasso', input, pixel, null)
      return true
    case 'hand':
      return false
    case 'add-anchor':
      if (!addAnchorAt(s, point, projection)) select(s, [])
      return true
    case 'delete-anchor':
    case 'anchor': {
      // Anchors are overlay handles and arrive through pressHandle; the map itself just selects.
      const near = pathNear(s, point, projection)
      select(s, near === null ? [] : [near.item.id])
      return true
    }
    case 'pen':
      pressPen(s, input, point, projection)
      return true
    case 'pencil':
      s.raster = new PixelSet()
      s.raster.stamp(pixel.x, pixel.y, s.settings.pencilWidth)
      s.lastStamp = pixel
      startDrag(s, 'raster', input, pixel, null)
      bump(s)
      return true
    case 'eraser': {
      const set = new PixelSet()
      set.stamp(pixel.x, pixel.y, s.settings.eraserWidth)
      // The cut through vector shapes follows the same pixel centres the raster stamps.
      s.erasing = { set, line: [{ x: pixel.x + 0.5, y: pixel.y + 0.5 }] }
      s.lastStamp = pixel
      startDrag(s, 'erase', input, pixel, null)
      bump(s)
      return true
    }
    case 'brush':
      select(s, [])
      s.stroke = [{ x: pixel.x + 0.5, y: pixel.y + 0.5 }]
      startDrag(s, 'stroke', input, pixel, null)
      bump(s)
      return true
    default:
      select(s, [])
      s.drawing = shapeFrom(s, pixel, pixel)
      startDrag(s, 'draw', input, pixel, null)
      bump(s)
      return true
  }
}

const pressPen = (
  s: EditorState,
  input: PointerInput,
  point: Point,
  projection: ScreenProjection | null,
): void => {
  if (s.pen === null) {
    // Not drawing: a click on a selected path's segment adds an anchor there instead.
    const near = pathNear(s, point, projection)
    if (near !== null && isSelected(s, near.item.id)) {
      addAnchorAt(s, point, projection)
      return
    }
  }
  const first = s.pen?.[0]
  const start =
    first === undefined || projection === null ? null : projection.pointFor(first.x, first.y)
  if (
    s.pen !== null &&
    s.pen.length >= 3 &&
    start !== null &&
    Math.hypot(input.client.x - start.x, input.client.y - start.y) <= HIT_RADIUS_CSS
  ) {
    commitPen(s, true)
    return
  }
  s.pen ??= []
  if (s.pen.length >= MAX_PATH_NODES) {
    s.message = pathFullMessage
    return
  }
  // Anchors sit wherever the pointer is; the grid only matters once the path is rasterised.
  s.pen = [...s.pen, { x: point.x, y: point.y }]
  startDrag(s, 'pen', input, { x: point.x, y: point.y }, null, s.pen.length - 1)
  bump(s)
}

/** The pointer over the map with no gesture in hand: the rubber band and the cursor. */
export const hoverMap = (
  s: EditorState,
  input: PointerInput,
  projection: ScreenProjection | null,
): void => {
  if (s.tool === 'pen' && s.pen !== null) s.hover = input.point
  if (!isSelectionTool(s.tool)) {
    s.cursor = toolCursor(s.tool)
    return
  }
  const over =
    input.point !== null && itemAt(s, worldPixel(input.point.x), worldPixel(input.point.y)) !== null
  s.cursor = inRotateZone(s, input.client, projection) ? ROTATE_CURSOR : over ? 'move' : 'default'
}

/** Where a drag has reached: the canvas point, its pixel, and Shift. */
interface DragStep {
  readonly point: Point
  readonly pixel: Point
  readonly shiftKey: boolean
}

/**
 * What each gesture does as the pointer moves, when it ends, and when the browser cancels it.
 * `move` answers whether anything changed. A cancelled drag puts back what it changed.
 */
interface DragSpec {
  move(s: EditorState, drag: Drag, step: DragStep): boolean
  end?(s: EditorState, drag: Drag, shiftKey: boolean): void
  cancel?(s: EditorState, drag: Drag): void
}

const restoreBase: DragSpec['cancel'] = (s, drag) => {
  if (drag.base !== null) restoreItems(s, [drag.base])
}

/** The selected path as it is now, when the drag's item is a path. */
const currentPath = (s: EditorState, drag: Drag): PathShape | null => {
  if (drag.base?.shape.kind !== 'path') return null
  const current = selectedItem(s)
  return current?.shape.kind === 'path' ? current.shape : null
}

const DRAGS: Record<DragKind, DragSpec> = {
  draw: {
    move: (s, drag, { pixel }) => {
      s.drawing = shapeFrom(s, drag.origin, pixel)
      bump(s)
      return true
    },
    end: (s) => {
      if (s.drawing !== null) addItem(s, s.drawing)
      s.drawing = null
    },
  },
  move: {
    move: (s, drag, { pixel }) => {
      if (drag.base === null || !drag.moved) return false
      // Every selected shape travels by the same whole-pixel offset.
      const dx = pixel.x - drag.origin.x
      const dy = pixel.y - drag.origin.y
      const moved = new Map(drag.group.map((item) => [item.id, item] as const))
      s.items = s.items.map((item) => {
        const was = moved.get(item.id)
        return was === undefined
          ? item
          : { ...item, shape: translateRegionShape(was.shape, dx, dy) }
      })
      touch(s)
      s.cursor = 'grabbing'
      return true
    },
    cancel: (s, drag) => restoreItems(s, drag.group),
  },
  marquee: {
    move: (s, _drag, { point }) => {
      if (s.marquee === null) return false
      const marquee = { ...s.marquee, x1: point.x, y1: point.y }
      s.marquee = marquee
      const caught = s.items.filter((item) => inMarquee(item.shape, marquee))
      select(s, [...s.baseSelection, ...caught.map((item) => item.id)])
      return true
    },
    end: (s, drag, shiftKey) => endSelectionGesture(s, drag, shiftKey),
  },
  lasso: {
    move: (s, _drag, { point }) => {
      if (s.lasso === null) return false
      const last = s.lasso[s.lasso.length - 1] as Point
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 1)
        s.lasso = [...s.lasso, { x: point.x, y: point.y }]
      const ring = s.lasso
      const caught = s.items.filter((item) => inLasso(item.shape, ring))
      select(s, [...s.baseSelection, ...caught.map((item) => item.id)])
      return true
    },
    end: (s, drag, shiftKey) => endSelectionGesture(s, drag, shiftKey),
  },
  corner: {
    move: (s, drag, { pixel }) => {
      const base = drag.base
      if (base === null || (base.shape.kind !== 'rectangle' && base.shape.kind !== 'ellipse'))
        return false
      replaceItem(s, base.id, boxShape(base.shape.kind, drag.origin, pixel))
      return true
    },
    cancel: restoreBase,
  },
  outer: {
    move: (s, drag, { pixel }) => {
      const base = drag.base
      if (base === null || (base.shape.kind !== 'polygon' && base.shape.kind !== 'star'))
        return false
      replaceItem(
        s,
        base.id,
        roundShape(base.shape.kind, drag.origin, pixel, s.settings, base.shape),
      )
      return true
    },
    cancel: restoreBase,
  },
  inner: {
    move: (s, drag, { pixel }) => {
      const base = drag.base
      if (base?.shape.kind !== 'star') return false
      const inner = starInner(
        base.shape.r,
        Math.hypot(pixel.x - base.shape.cx, pixel.y - base.shape.cy),
      )
      s.settings.inner = Math.round((inner / base.shape.r) * 100)
      replaceItem(s, base.id, { ...base.shape, inner })
      return true
    },
    cancel: restoreBase,
  },
  node: {
    move: (s, drag, { point }) => {
      const path = currentPath(s, drag)
      if (path === null || drag.base?.shape.kind !== 'path') return false
      replaceItem(s, drag.base.id, moveNode(path, drag.index, drag.part, point, drag.base.shape))
      return true
    },
    cancel: restoreBase,
  },
  scale: {
    move: (s, drag, { point, shiftKey }) => {
      const base = drag.base
      if (base === null || (base.shape.kind !== 'path' && base.shape.kind !== 'pixels'))
        return false
      const anchor = drag.origin
      const from = scaleBoxCorners(base.shape)[drag.index] as Point
      const spanX = from.x - anchor.x
      const spanY = from.y - anchor.y
      // A box cannot collapse to nothing: the dragged corner keeps at least half a pixel away.
      const keep = (value: number, span: number): number =>
        Math.abs(value) < 0.5 ? (span < 0 ? -0.5 : 0.5) : value
      let sx = spanX === 0 ? 1 : keep(point.x - anchor.x, spanX) / spanX
      let sy = spanY === 0 ? 1 : keep(point.y - anchor.y, spanY) / spanY
      if (shiftKey) {
        // Shift keeps the proportions, following whichever axis was pulled further.
        const uniform = Math.max(Math.abs(sx), Math.abs(sy))
        sx = Math.sign(sx) * uniform
        sy = Math.sign(sy) * uniform
      }
      const scaled = scaleShape(base.shape, anchor, sx, sy)
      if (scaled === null) s.message = 'That is too large for one drawing.'
      else replaceItem(s, base.id, scaled)
      return true
    },
    cancel: restoreBase,
  },
  rotate: {
    move: (s, drag, { point, shiftKey }) => {
      if (drag.base === null) return false
      const centre = drag.origin
      let radians =
        Math.atan2(point.y - centre.y, point.x - centre.x) -
        Math.atan2(drag.press.y - centre.y, drag.press.x - centre.x)
      if (shiftKey) {
        const step = (ROTATE_SNAP_DEGREES * Math.PI) / 180
        radians = Math.round(radians / step) * step
      }
      replaceItem(s, drag.base.id, rotateShape(drag.base.shape, centre, radians))
      s.cursor = ROTATE_CURSOR
      return true
    },
    cancel: restoreBase,
  },
  raster: {
    move: (s, _drag, { pixel }) => {
      if (s.raster === null) return false
      s.raster.line(s.lastStamp ?? pixel, pixel, s.settings.pencilWidth)
      s.lastStamp = pixel
      bump(s)
      return true
    },
    end: (s) => finishRaster(s),
  },
  erase: {
    move: (s, _drag, { pixel }) => {
      if (s.erasing === null) return false
      s.erasing.set.line(s.lastStamp ?? pixel, pixel, s.settings.eraserWidth)
      s.lastStamp = pixel
      const last = s.erasing.line[s.erasing.line.length - 1] as Point
      const centre = { x: pixel.x + 0.5, y: pixel.y + 0.5 }
      if (Math.hypot(centre.x - last.x, centre.y - last.y) >= 1)
        s.erasing.line = [...s.erasing.line, centre]
      bump(s)
      return true
    },
    end: (s) => finishErase(s),
  },
  'anchor-convert': {
    move: (s, drag, { point }) => {
      if (drag.base === null || !drag.moved) return false
      const path = toPath(drag.base.shape)
      drag.kind = 'node'
      const id = drag.base.id
      drag.base = { ...drag.base, shape: path }
      replaceItem(s, id, moveNode(path, drag.index, 'anchor', point, path))
      return true
    },
    cancel: restoreBase,
  },
  'anchor-pull': {
    move: (s, drag, { point }) => {
      const path = currentPath(s, drag)
      if (path === null || drag.base === null || !drag.moved) return false
      // Dragging out of an anchor gives it a pair of handles pointing along the drag.
      const node = path.nodes[drag.index] as PathNode
      const nodes = path.nodes.map((held, at) =>
        at === drag.index ? smoothAnchor(node, { x: point.x, y: point.y }) : held,
      )
      replaceItem(s, drag.base.id, { ...path, nodes })
      return true
    },
    end: (s, drag) => {
      // A click on a smooth anchor, without a drag, makes it a corner.
      const path = currentPath(s, drag)
      if (drag.moved || path === null || drag.base === null) return
      if (!isSmooth(path.nodes[drag.index] as PathNode)) return
      replaceItem(s, drag.base.id, {
        ...path,
        nodes: path.nodes.map((held, at) => (at === drag.index ? cornerAnchor(held) : held)),
      })
    },
    cancel: restoreBase,
  },
  'handle-solo': {
    move: (s, drag, { point }) => {
      const path = currentPath(s, drag)
      if (path === null || drag.base === null) return false
      // One handle on its own: the other stays, which breaks the smooth pair into a cusp.
      const nodes = path.nodes.map((held, at) =>
        at === drag.index ? { ...held, [drag.part]: { x: point.x, y: point.y } } : held,
      )
      replaceItem(s, drag.base.id, { ...path, nodes })
      return true
    },
    cancel: restoreBase,
  },
  stroke: {
    move: (s, _drag, { pixel }) => {
      if (s.stroke === null) return false
      const last = s.stroke[s.stroke.length - 1] as Point
      const next = { x: pixel.x + 0.5, y: pixel.y + 0.5 }
      if (Math.hypot(next.x - last.x, next.y - last.y) < STROKE_STEP_PX) return false
      if (s.stroke.length >= MAX_PATH_NODES) return false
      s.stroke = [...s.stroke, next]
      bump(s)
      return true
    },
    end: (s) => {
      const nodes = s.stroke
      s.stroke = null
      if (nodes !== null && nodes.length >= 2)
        addItem(s, {
          kind: 'path',
          closed: false,
          width: s.tool === 'pencil' ? 1 : Math.max(1, s.settings.width),
          nodes,
        })
    },
  },
  pen: {
    move: (s, drag, { point }) => {
      if (s.pen === null || !drag.moved) return false
      // Dragging out of a fresh anchor pulls its out handle and mirrors the in handle.
      const anchor = s.pen[drag.index] as PathNode
      s.pen = s.pen.map((node, at) => (at === drag.index ? smoothAnchor(anchor, point) : node))
      bump(s)
      return true
    },
    cancel: (s, drag) => {
      if (s.pen !== null) s.pen = s.pen.filter((_, at) => at !== drag.index)
      if (s.pen !== null && s.pen.length === 0) s.pen = null
    },
  },
}

/** A click with no drag on empty canvas clears the selection, like Illustrator. */
const endSelectionGesture = (s: EditorState, drag: Drag, shiftKey: boolean): void => {
  if (!drag.moved && !shiftKey) select(s, [])
  s.marquee = null
  s.lasso = null
}

/** A pencil stroke joins the one selected drawing when there is one; otherwise it is a new one. */
const finishRaster = (s: EditorState): void => {
  const shape = s.raster?.shape() ?? null
  const tooLarge = s.raster !== null && shape === null
  s.raster = null
  s.lastStamp = null
  if (shape === null) {
    if (tooLarge) s.message = 'That drawing is too large for one raster; draw it in parts.'
    return
  }
  const selected = selectedItem(s)
  if (selected !== null && selected.shape.kind === 'pixels' && selected.op === op(s)) {
    const merged = mergeRasters(selected.shape, shape)
    if (merged !== null) {
      replaceItem(s, selected.id, merged)
      return
    }
  }
  addItem(s, shape)
}

/**
 * The eraser is done: pixels it covered leave every raster, and every vector shape it crossed
 * is cut into the pieces it leaves behind, each its own editable path.
 */
const finishErase = (s: EditorState): void => {
  const erasing = s.erasing
  s.erasing = null
  s.lastStamp = null
  if (erasing === null || erasing.set.size === 0) return
  let area: ReturnType<typeof strokeArea> | null = null
  const next: RegionItem[] = []
  let changed = false
  let refused: string | null = null
  for (const [index, item] of s.items.entries()) {
    if (item.shape.kind === 'pixels') {
      const left = eraseFromRaster(item.shape, erasing.set)
      if (left === item.shape) next.push(item)
      else {
        changed = true
        if (left !== null) next.push({ ...item, shape: left })
      }
      continue
    }
    if (!rasterTouches(item.shape, erasing.set)) {
      next.push(item)
      continue
    }
    area ??= strokeArea(erasing.line, s.settings.eraserWidth)
    const pieces = splitItem(item, area, nextItemId)
    // What is kept so far, plus these pieces, plus every item still to come, must fit per claim.
    const error = limitError(s, { items: [...next, ...pieces, ...s.items.slice(index + 1)] })
    if (error !== null) {
      refused = error
      next.push(item)
      continue
    }
    changed = true
    next.push(...pieces)
  }
  if (refused !== null) s.message = refused
  if (!changed) return
  s.items = next
  select(s, [])
  touch(s)
}

/** The drag follows the pointer. False when nothing changed worth redrawing. */
export const dragTo = (s: EditorState, input: PointerInput): boolean => {
  const drag = s.drag
  if (drag === null || input.point === null) return false
  if (
    Math.abs(input.client.x - drag.client.x) > CLICK_SLOP_PX ||
    Math.abs(input.client.y - drag.client.y) > CLICK_SLOP_PX
  )
    drag.moved = true
  const step = {
    point: input.point,
    pixel: { x: worldPixel(input.point.x), y: worldPixel(input.point.y) },
    shiftKey: input.shiftKey,
  }
  return DRAGS[drag.kind].move(s, drag, step)
}

/** The pointer is released: the gesture commits. */
export const endDrag = (s: EditorState, shiftKey: boolean): void => {
  const drag = s.drag
  if (drag === null) return
  s.drag = null
  DRAGS[drag.kind].end?.(s, drag, shiftKey)
  bump(s)
  s.cursor = toolCursor(s.tool)
}

/**
 * A cancelled pointer (the browser took it: a gesture, a lost capture) is not a release. What a
 * drag changed goes back and what it was drawing is dropped.
 */
export const cancelDrag = (s: EditorState): void => {
  const drag = s.drag
  if (drag === null) return
  s.drag = null
  DRAGS[drag.kind].cancel?.(s, drag)
  s.drawing = null
  s.stroke = null
  s.raster = null
  s.erasing = null
  s.lastStamp = null
  s.marquee = null
  s.lasso = null
  bump(s)
  s.cursor = toolCursor(s.tool)
}

/** Switch tools; an open pen path is finished first. */
export const setTool = (s: EditorState, next: ClaimTool): void => {
  if (s.pen !== null && next !== 'pen') commitPen(s, false)
  s.tool = next
  s.shown = { ...s.shown, [claimToolEntry(next).group]: next }
  if (next !== 'hand') s.handHeldFrom = null
  s.marquee = null
  s.lasso = null
  s.cursor = toolCursor(next)
}

export const deleteSelected = (s: EditorState): void => {
  if (s.selectedIds.length === 0) return
  s.items = s.items.filter((item) => !isSelected(s, item.id))
  select(s, [])
  touch(s)
}

export const clearSelection = (s: EditorState): void => select(s, [])

/** Set a tool option; the selected shape follows it, so a count or width is also an edit. */
export const setOption = (s: EditorState, option: ClaimOption, value: number): void => {
  const settings = s.settings
  const clamped = clampClaimOption(option, s.tool, value)
  if (option === 'width') {
    if (s.tool === 'pencil') settings.pencilWidth = clamped
    else if (s.tool === 'eraser') settings.eraserWidth = clamped
    else settings.width = clamped
  } else settings[option] = clamped
  const selected = selectedItem(s)
  if (selected === null) return
  const shape = selected.shape
  if (option === 'sides' && shape.kind === 'polygon')
    replaceItem(s, selected.id, { ...shape, sides: settings.sides })
  if (option === 'points' && shape.kind === 'star')
    replaceItem(s, selected.id, { ...shape, points: settings.points })
  if (option === 'inner' && shape.kind === 'star')
    replaceItem(s, selected.id, {
      ...shape,
      inner: starInner(shape.r, (shape.r * settings.inner) / 100),
    })
  if (option === 'width' && shape.kind === 'path' && (shape.closed || settings.width > 0))
    replaceItem(s, selected.id, { ...shape, width: settings.width })
}

/** Whether new shapes cut out of the claim; the selected shapes switch with it. */
export const setSubtract = (s: EditorState, subtract: boolean): void => {
  s.settings.subtract = subtract
  if (s.selectedIds.length === 0) return
  s.items = s.items.map((item) => (isSelected(s, item.id) ? { ...item, op: op(s) } : item))
  touch(s)
}
