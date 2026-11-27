import type { RegionDocument, RegionShapePixels } from '@caelestis/shared'
import {
  type CaelestisElement,
  type CaptureAction,
  type ClaimModeIntent,
  type ClaimModeModel,
  type ClaimTool,
  claimToolForKey,
} from '@caelestis/ui/elements'
import { cancelSurfaceClose, closeSurface, openSurface } from '@caelestis/ui/motion'
import {
  cancelDrag,
  clearSelection,
  commitPen,
  defaultToolSettings,
  deleteSelected,
  derive,
  dragTo,
  dropPen,
  type EditorPixels,
  type EditorState,
  editorModel,
  endDrag,
  hoverMap,
  openEditor,
  type PointerInput,
  pressHandle,
  pressMap,
  selectedItem,
  setOption,
  setSubtract,
  setTool,
} from './claim-editor-state.js'
import { CLAIM_OVERLAY_ID, handleOf, overlayMarks, renderOverlay } from './claim-overlay.js'
import type { ClaimSaveResult } from './claim-routing.js'
import { errorText } from './error-text.js'
import { notifyListeners } from './listeners.js'
import { getMap } from './map-handle.js'
import { isMapPress, mapPointAt, swallowNextClick } from './map-pointer.js'
import { isMapInteractionTarget, screenProjection } from './map-view.js'
import { applyWplaceTheme } from './ui/theme.js'
import { MAP_CANVAS, OPEN_DIALOG, typingInTextField } from './wplace-dom.js'
import { dismissWplacePixelCard } from './wplace-pixel-card.js'

/**
 * Claim mode on the page: window listeners that take drawing gestures before they reach the map,
 * the `<caelestis-claim-mode>` toolbar, the SVG overlay, and the session around a save or a
 * capture. What a gesture does to the document is `claim-editor-state`'s; outside the editor,
 * gestures pass through untouched. Desktop tools sit at the left and top; phones use one bottom
 * toolbar. The wheel pans, Shift+wheel pans sideways, and Alt/Option or Ctrl/Cmd+wheel zooms.
 */

const MODE_ID = 'caelestis-claim-mode'
/** Wheel delta units for `deltaMode` line and page, in CSS pixels. */
const WHEEL_LINE_PX = 16
const WHEEL_PAGE_PX = 100

export interface ClaimEditorHost {
  /** The template the claim overlaps, by name, or null. Information only; never a gate. */
  readonly templateFor: (document: RegionDocument) => string | null
  /**
   * This painter's saved claims on the server claim mode edits. They all load together: claim
   * mode is where every one of your regions is edited, and Save writes the whole set back.
   */
  readonly myRegions: () => readonly { readonly id: string; readonly document: RegionDocument }[]
  /**
   * Persist the whole set of independent claims at once: each document keeps the id of the
   * record it came from where one survives, gets a fresh id otherwise, and loaded ids with no
   * document left are released. The returned ids are what the next save must name.
   */
  readonly save: (
    ids: readonly string[],
    documents: readonly RegionDocument[],
  ) => Promise<ClaimSaveResult>
}

export interface ClaimCaptureHost {
  /** Capture new art, or update parts of an existing template. Enter runs the matching action. */
  readonly purpose: 'capture' | 'update'
  /**
   * Capture the art under the selection mask, then download it or add it as a template. Resolves
   * to null when done, which leaves capture mode, or to a message that keeps the selection open.
   * The signal aborts when the editor closes. The host must discard cancelled work, including
   * any temporary template admission, before it can start placement or download a file.
   */
  readonly capture: (
    selection: RegionShapePixels,
    action: CaptureAction,
    signal: AbortSignal,
  ) => Promise<string | null>
}

let host: ClaimEditorHost | null = null
let installed = false
/** The open session, or null outside claim and capture mode. */
let editor: EditorState | null = null
/** Set while the editor selects art to capture rather than regions to claim. */
let captureHost: ClaimCaptureHost | null = null
let captureController: AbortController | null = null
const settings = defaultToolSettings()
/** Counts sessions, so a request from an earlier one cannot act on a later one. */
let session = 0
/**
 * A press the editor consumed without starting a drag. Its release and the click that follows
 * are consumed too, or Wplace would still treat the click as a pixel selection.
 */
let consumedPress: number | null = null
/** Wplace also listens to Touch Events, so consuming a pointer alone still lets the map pan. */
let drawingTouch = false
let appliedCursor = ''
let overlay: SVGSVGElement | null = null
type ClaimModeElement = CaelestisElement<'caelestis-claim-mode'>

let mode: ClaimModeElement | null = null
/** A mode element still running its exit transition — reclaimable if the editor restarts. */
let closingMode: ClaimModeElement | null = null
const listeners: (() => void)[] = []

const notify = (): void => {
  notifyListeners(listeners, 'claim editor listener failed')
  syncMode()
  syncOverlay()
  applyCursor()
}

export const onClaimEditorChange = (listener: () => void): void => {
  listeners.push(listener)
}

/** Whether the editor is open, for claims or for a capture. */
export const isClaimModeActive = (): boolean => editor !== null

export const isCaptureModeActive = (): boolean => editor !== null && captureHost !== null

export const claimEditorTool = (): ClaimTool | null => editor?.tool ?? null

const NOT_EDITING: readonly string[] = []

/**
 * The saved claims loaded into the editor, so their stored copies step aside in the layer. The
 * same array until the editor changes, so the presence scene can tell nothing changed.
 */
export const claimEditorEditingIds = (): readonly string[] => editor?.editingIds ?? NOT_EDITING

/** The working document as pixels, mid-gesture included, for the presence layer. */
export const claimEditorPixels = (): EditorPixels | null =>
  editor === null ? null : derive(editor).pixels

export const claimModeModel = (): ClaimModeModel | null =>
  editor === null
    ? null
    : editorModel(
        editor,
        editor.items.length === 0 ? null : (host?.templateFor({ items: editor.items }) ?? null),
      )

const applyCursor = (): void => {
  const value = editor?.cursor ?? ''
  if (value === appliedCursor) return
  appliedCursor = value
  const canvas = document.querySelector<HTMLElement>(MAP_CANVAS)
  if (canvas !== null) canvas.style.cursor = value
}

const consume = (event: Event): void => {
  event.preventDefault()
  event.stopPropagation()
  if (event instanceof PointerEvent && event.type === 'pointerdown') consumedPress = event.pointerId
}

const onTouch = (event: TouchEvent): void => {
  if (event.type === 'touchstart' && editor !== null && consumedPress !== null) drawingTouch = true
  if (!drawingTouch) return
  consume(event)
  if (event.touches.length === 0) drawingTouch = false
}

/** The click after a gesture belongs to the editor when it lands on the map or the overlay. */
const swallowClick = (): void =>
  swallowNextClick(
    (target) =>
      isMapInteractionTarget(target) ||
      (target instanceof Node && overlay?.contains(target) === true),
  )

const pointerInput = (event: PointerEvent): PointerInput => ({
  pointerId: event.pointerId,
  client: { x: event.clientX, y: event.clientY },
  point: mapPointAt(event.clientX, event.clientY),
  shiftKey: event.shiftKey,
})

const changeTool = (s: EditorState, next: ClaimTool): void => {
  // Hand-tool clicks reach Wplace and can open its pixel card; it is stale again from here.
  if (s.tool === 'hand' && next !== 'hand') dismissWplacePixelCard()
  setTool(s, next)
  notify()
}

const onPointerDown = (event: PointerEvent): void => {
  const s = editor
  if (s === null || host === null || s.pending || s.drag !== null || event.button !== 0) return
  const handle = handleOf(event.target)
  if (handle !== undefined) {
    if (selectedItem(s) === null || !(event.target instanceof Element)) return
    consume(event)
    try {
      event.target.setPointerCapture(event.pointerId)
    } catch {
      // The pointer is already released; window listeners still see the moves.
    }
    pressHandle(s, handle, pointerInput(event))
    notify()
    return
  }
  if (!isMapPress(event.target)) return
  if (!pressMap(s, pointerInput(event), screenProjection())) return
  consume(event)
  notify()
}

const onPointerMove = (event: PointerEvent): void => {
  const s = editor
  if (s === null || host === null) return
  if (s.drag === null) {
    if (isMapPress(event.target)) {
      hoverMap(s, pointerInput(event), screenProjection())
      if (s.tool === 'pen' && s.pen !== null) syncOverlay()
    } else s.cursor = ''
    applyCursor()
    return
  }
  if (event.pointerId !== s.drag.pointerId) return
  consume(event)
  if (dragTo(s, pointerInput(event))) notify()
}

const onPointerEnd = (event: PointerEvent): void => {
  const s = editor
  if (s === null) return
  if (s.drag === null) {
    if (consumedPress !== event.pointerId) return
    // A click the editor answered (a selection, an anchor) never reaches Wplace.
    consumedPress = null
    consume(event)
    swallowClick()
    return
  }
  if (event.pointerId !== s.drag.pointerId) return
  consumedPress = null
  consume(event)
  swallowClick()
  endDrag(s, event.shiftKey)
  notify()
}

/** A cancelled pointer is not a release: no click is expected after it. */
const onPointerCancel = (event: PointerEvent): void => {
  const s = editor
  if (s === null) return
  if (s.drag === null) {
    if (consumedPress === event.pointerId) consumedPress = null
    return
  }
  if (event.pointerId !== s.drag.pointerId) return
  consumedPress = null
  cancelDrag(s)
  notify()
}

/** Keys inside an open dialog, such as an update's confirmation, belong to that dialog. */
const inDialog = (event: Event): boolean =>
  event.composedPath().some((node) => node instanceof Element && node.matches(OPEN_DIALOG))

const onKeydown = (event: KeyboardEvent): void => {
  const s = editor
  if (
    s === null ||
    // A text field, ours in the toolbar or the page's, keeps its keys.
    typingInTextField(event) ||
    inDialog(event) ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return
  if (s.pending) {
    // A save is in flight with a snapshot of the document; an edit now would be lost with it.
    consume(event)
    return
  }
  switch (event.key.toLowerCase()) {
    case ' ':
      // Holding space is a temporary hand, as in Illustrator; the tool comes back on release.
      consume(event)
      if (s.handHeldFrom !== null || s.tool === 'hand' || s.drag !== null) return
      s.handHeldFrom = s.tool
      changeTool(s, 'hand')
      return
    case 'escape':
      // An open tool flyout closes on Escape by itself; the editor stays out of it.
      if (mode?.shadowRoot?.querySelector('[role="menu"]') != null) return
      consume(event)
      if (s.pen !== null) dropPen(s)
      else if (s.selectedIds.length > 0) clearSelection(s)
      else {
        stopClaimMode()
        return
      }
      notify()
      return
    case 'enter':
      consume(event)
      if (s.pen === null) {
        void confirm()
        return
      }
      commitPen(s, false)
      notify()
      return
    case 'delete':
    case 'backspace':
      consume(event)
      deleteSelected(s)
      notify()
      return
  }
  const next = claimToolForKey(event.key, event.shiftKey)
  if (next === null) return
  consume(event)
  changeTool(s, next)
}

const onKeyup = (event: KeyboardEvent): void => {
  const s = editor
  if (s === null || event.key !== ' ' || s.handHeldFrom === null) return
  const back = s.handHeldFrom
  s.handHeldFrom = null
  changeTool(s, back)
}

/**
 * The wheel in claim mode, Illustrator-style: scroll pans, Shift+scroll pans sideways, and a
 * zoom needs Alt/Option or Ctrl/Cmd. Plain wheels are consumed and turned into a pan so the map
 * never zooms under a stray scroll; modified ones pass through to the map's own zoom.
 */
const onWheel = (event: WheelEvent): void => {
  if (editor === null || event.altKey || event.ctrlKey || event.metaKey) return
  if (!isMapInteractionTarget(event.target)) return
  const map = getMap()
  if (map === null) return
  consume(event)
  const scale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? WHEEL_LINE_PX
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? WHEEL_PAGE_PX
        : 1
  let dx = event.deltaX * scale
  let dy = event.deltaY * scale
  if (event.shiftKey && dx === 0) {
    dx = dy
    dy = 0
  }
  if (dx === 0 && dy === 0) return
  map.panBy([dx, dy], { animate: false })
}

/** Hand the selection to the capture host. A failure keeps the selection so it can be retried. */
const capture = async (action: CaptureAction): Promise<void> => {
  const s = editor
  const target = captureHost
  if (s === null || s.pending || target === null) return
  if (s.pen !== null) commitPen(s, false)
  const { error, pixels } = derive(s)
  const selection = pixels?.parts[0]
  if (error !== null || selection === undefined) {
    s.message = error ?? 'Draw around the art to capture first.'
    notify()
    return
  }
  const mine = session
  const controller = new AbortController()
  captureController = controller
  s.pending = true
  s.message = undefined
  notify()
  let failure: string | null
  try {
    failure = await target.capture(selection, action, controller.signal)
  } catch (thrown) {
    failure = errorText(thrown)
  }
  if (captureController === controller) captureController = null
  if (session !== mine || controller.signal.aborted) return
  s.pending = false
  if (editor !== s) return
  if (failure === null) stopClaimMode()
  else {
    s.message = failure
    notify()
  }
}

/**
 * Save writes your whole set of regions back: every independent group of touching shapes
 * becomes its own claim, saved under the id it came from where one survives, and loaded claims
 * with no shapes left are released by the router once the new records are accepted. An empty
 * set releases everything. Removed shapes are simply absent from what is written.
 */
const confirm = async (): Promise<void> => {
  if (captureHost !== null) return capture(captureHost.purpose === 'update' ? 'update' : 'template')
  const s = editor
  const target = host
  if (s === null || s.pending || target === null) return
  if (s.pen !== null) commitPen(s, false)
  if (!s.dirty) {
    stopClaimMode()
    return
  }
  const { error, documents } = derive(s)
  if (error !== null) {
    s.message = error
    notify()
    return
  }
  const mine = session
  const ids = s.editingIds
  s.pending = true
  s.message = undefined
  notify()
  let result: ClaimSaveResult
  try {
    result = await target.save(ids, documents)
  } catch (thrown) {
    result = { ids, error: String(thrown) }
  }
  // Escape during the wait ends this session; whatever opened since is not this request's.
  if (session !== mine) return
  s.pending = false
  if (editor !== s) return
  s.editingIds = result.ids
  if (result.error === null) stopClaimMode()
  else {
    s.dirty = true
    s.message = result.error
    notify()
  }
}

export const handleClaimModeIntent = (intent: ClaimModeIntent): void => {
  const s = editor
  if (s === null) return
  switch (intent.type) {
    case 'set-tool':
      changeTool(s, intent.tool)
      return
    case 'set-option':
      setOption(s, intent.option, intent.value)
      break
    case 'set-subtract':
      // A pending capture or save is using the current selection; a failure retries with it.
      if (s.pending) return
      setSubtract(s, intent.subtract)
      break
    case 'delete-item':
      deleteSelected(s)
      notify()
      return
    case 'confirm':
      void confirm()
      return
    case 'capture':
      void capture(intent.action)
      return
    case 'cancel':
      stopClaimMode()
      return
  }
  s.message = undefined
  notify()
}

/* Chrome: the mode element and the SVG overlay. */

const ensureMode = (): ClaimModeElement => {
  if (mode?.isConnected) return mode
  // A restart while the old element is still closing reclaims it — never two nodes with one id.
  if (closingMode?.isConnected && cancelSurfaceClose(closingMode)) {
    mode = closingMode
    closingMode = null
    openSurface(mode)
    return mode
  }
  closingMode = null
  const element = document.createElement('caelestis-claim-mode')
  element.id = MODE_ID
  Object.assign(element.style, {
    position: 'fixed',
    inset: '0',
    // Editor actions must stay above the docked panel (30), below its popovers (40).
    zIndex: '31',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  applyWplaceTheme(element)
  element.addEventListener('caelestis-claim-mode-intent', (event) => {
    handleClaimModeIntent(event.detail)
  })
  document.body.appendChild(element)
  openSurface(element)
  mode = element
  return element
}

const syncMode = (): void => {
  const model = claimModeModel()
  if (model !== null) {
    ensureMode().model = model
    return
  }
  if (mode === null) return
  const leaving = mode
  mode = null
  closingMode = leaving
  closeSurface(leaving, () => {
    if (closingMode === leaving) closingMode = null
    leaving.remove()
  })
}

const ensureOverlay = (): SVGSVGElement => {
  if (overlay?.isConnected) return overlay
  overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  overlay.id = CLAIM_OVERLAY_ID
  overlay.setAttribute('aria-hidden', 'true')
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    // Under the presence labels (20) and the panel (30).
    zIndex: '18',
    pointerEvents: 'none',
    overflow: 'visible',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(overlay)
  return overlay
}

const syncOverlay = (): void => {
  if (editor === null) {
    overlay?.remove()
    overlay = null
    return
  }
  const root = ensureOverlay()
  const projection = screenProjection()
  if (projection === null) root.replaceChildren()
  else renderOverlay(root, overlayMarks(editor, projection))
}

/* Lifecycle. */

export const installClaimEditor = (editorHost: ClaimEditorHost): void => {
  host = editorHost
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerEnd, true)
  window.addEventListener('pointercancel', onPointerCancel, true)
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)
}

const TOUCH_TYPES = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const
const BLOCKING = { capture: true, passive: false } as const

/**
 * Touch and wheel listeners that may cancel, held only while the editor is open. Outside it, a
 * non-passive listener on the window would make every scroll and pinch on the map wait for it.
 */
const setBlockingInput = (on: boolean): void => {
  if (on) {
    for (const type of TOUCH_TYPES) window.addEventListener(type, onTouch, BLOCKING)
    window.addEventListener('wheel', onWheel, BLOCKING)
    return
  }
  for (const type of TOUCH_TYPES) window.removeEventListener(type, onTouch, BLOCKING)
  window.removeEventListener('wheel', onWheel, BLOCKING)
}

const enter = (
  initialTool: ClaimTool,
  saved: ReturnType<ClaimEditorHost['myRegions']>,
  capturing: ClaimCaptureHost | null,
): void => {
  editor = openEditor(capturing?.purpose ?? 'claim', initialTool, saved, settings)
  setBlockingInput(true)
  session++
  captureHost = capturing
  // Whatever pixel Wplace had selected is stale now that clicks belong to the editor.
  dismissWplacePixelCard()
  notify()
}

/** Enter claim mode with a tool in hand. Every one of your saved regions loads for editing. */
export const startClaimMode = (initialTool?: ClaimTool): void => {
  if (host === null) return
  if (editor !== null) {
    if (initialTool !== undefined && captureHost === null) changeTool(editor, initialTool)
    return
  }
  enter(initialTool ?? 'select', host.myRegions(), null)
}

/**
 * Enter capture mode with the rectangle in hand and nothing loaded. False while the editor is
 * already open, so unsaved claims or another capture are never thrown away.
 */
export const startCaptureMode = (target: ClaimCaptureHost): boolean => {
  if (host === null || editor !== null) return false
  enter('rectangle', [], target)
  return true
}

/** Leave claim or capture mode. Nothing unsaved survives this. */
export const stopClaimMode = (): void => {
  if (editor === null) return
  editor = null
  setBlockingInput(false)
  // Its touchend may now never arrive; the next session starts without a gesture in hand.
  drawingTouch = false
  captureController?.abort()
  captureController = null
  captureHost = null
  consumedPress = null
  notify()
}

/** Follow the map: outlines and handles move with the canvas. */
export const syncClaimEditorFrame = (): void => {
  if (editor !== null) syncOverlay()
}
