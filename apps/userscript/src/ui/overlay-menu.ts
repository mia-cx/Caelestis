import {
  sameTemplateSurface,
  type TemplateSurface,
  templateSurfaceKey,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type {
  CaelestisRailControl,
  OverlayControlsIntent,
  RailControlModel,
} from '@caelestis/ui/elements'
import {
  closeSurface,
  openSurface,
  prefersReducedMotion,
  SETTLE_MARGIN_MS,
} from '@caelestis/ui/motion'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import { templateBusy } from '../application/template-busy.js'
import { requestTemplateArtworkUpdate } from '../application/update-template-artwork.js'
import { ALLIANCE_PANEL_ID, ALLIANCE_RAIL_ID, PANEL_ID } from '../chrome-ids.js'
import type { ScreenProjection } from '../coordinates.js'
import { log } from '../debug.js'
import { redraw, repaint, screenProjection } from '../map-view.js'
import { shortcutHint } from '../shortcuts.js'
import {
  isTemplateVisible,
  localTemplates,
  type PlacedTemplate,
  previewOriginFor,
} from '../templates/catalog.js'
import {
  abort as abortMove,
  alreadyAnswered,
  commit as commitMove,
  isFinishing,
  isMoving,
  movingId,
} from '../templates/move.js'
import { OPEN_DIALOG } from '../wplace-dom.js'
import { handleAppearanceIntent } from './appearance.js'
import { CLEAR_OF_RAIL, EDGE, GAP, RAIL_BUTTON } from './metrics.js'
import {
  actionIds,
  expireFailures,
  forgetActions,
  isConfirmingDelete,
  type MenuHost,
  menuSignature,
  overlayActions,
  overlayModel,
  stopHiddenPlacement,
} from './overlay-actions.js'
import {
  flushDrafts,
  forgetWrites,
  templateAppearanceStore,
  templateFor,
  withFrameTemplates,
  writtenIds,
} from './overlay-writes.js'
import { allianceRailTop } from './panel-scope.js'
import { mountRailButton } from './rail-button.js'
import { createRangeGestures } from './range-gestures.js'
import { applyWplaceTheme } from './theme.js'
import { findWplaceRightControls, onWplaceLayoutChange } from './wplace-rail.js'

/**
 * The per-overlay menu, anchored to the overlay it configures.
 *
 * The drawer answers *which overlays exist*, and this answers *how does this one look*. Anchoring
 * it to the thing it affects removes the selection step entirely: there is no "which template am I
 * configuring" because you pointed at it.
 *
 * Positioned to the right of the overlay and aligned to its top edge, outside the bounding box, so
 * it never covers template pixels, which matters most on exactly the dense templates people most
 * want to adjust. Top-aligned means it does not move when a template's height changes between
 * versions, and a column of stacked overlays produces a readable column of buttons rather than a
 * diagonal.
 *
 * **It does not dismiss on outside clicks.** Everything in here changes what is on the map behind
 * it, so clicking the map to look at the result must not close the thing you are adjusting. It
 * closes on its own ✕, its own gear, Escape, and nothing else.
 *
 * ## The menu is a render, not a place to keep things
 *
 * Intended appearance and refused writes live in `overlay-writes.ts`; the menu is a pure function
 * of them and of `overlay-actions.ts`. Nothing is read back out of the DOM and nothing is carried
 * from one menu element to the next.
 */

const MENU_ID = 'caelestis-overlay-menu'
const BUTTON_PREFIX = 'caelestis-overlay-button-'
/** Below the panel's z-30: while the drawer is open it is the focused surface and should win. */
const BUTTON_Z = '28'
const MENU_Z = '29'
/** As tall as the menu is ever allowed to want to be, before the room beside its gear is counted. */
const NATURAL_MAX_HEIGHT = '70vh'
const NATURAL_WIDTH = 'min(19.5rem, calc(100vw - 1rem))'
/** How far a gear or rail sits right of the overlay's top-right corner. */
const ANCHOR_OFFSET = 6
/** The left inset of map controls, inside the map or the artboard stage. */
const LEFT_INSET = 4
/** Our controls' identity attribute. */
const CONTROL = 'caelestisControl'

/**
 * The right edge available to controls anchored on the map.
 *
 * The main panel is resizable, so reserving its configured/default width is not enough. Its DOM
 * box is the authority while it exists (the panel removes itself when closed); otherwise Wplace's
 * live top-right control group is the boundary. That group is wider while logged out because it
 * includes the Log in button. Keep enough room for one reachable button in very narrow viewports,
 * even when the panel itself consumes nearly all of the map.
 */
const localControlsRightEdge = (): number => {
  const fallbackRailEdge = window.innerWidth - CLEAR_OF_RAIL
  const wplaceControls = findWplaceRightControls()?.getBoundingClientRect()
  let railEdge =
    wplaceControls !== undefined && wplaceControls.width > 0
      ? Math.min(fallbackRailEdge, wplaceControls.left - GAP)
      : fallbackRailEdge
  const allianceRail = document.getElementById(ALLIANCE_RAIL_ID)?.getBoundingClientRect()
  if (allianceRail !== undefined && allianceRail.width > 0) {
    railEdge = Math.min(railEdge, allianceRail.left - GAP)
  }
  const panel = document.getElementById(ALLIANCE_PANEL_ID) ?? document.getElementById(PANEL_ID)
  // A closing panel has already given its room back; measuring it would pin controls against a
  // box that is sliding away and then snap them once it is removed.
  if (panel === null || panel.dataset.state === 'closing') return railEdge
  return Math.max(EDGE + RAIL_BUTTON, Math.min(railEdge, panel.getBoundingClientRect().left - GAP))
}

/** The world controls' right edge, or null once something it was read from may have moved. */
let worldRightEdge: number | null = null
/** Until when every frame measures again: the panel drawer's open or close glide. */
let trackRightEdgeUntil = 0
let rightEdgeSizes: ResizeObserver | null = null
let sizedForRightEdge: readonly Element[] = []

/**
 * Measure the map controls' right edge again on the next render. For a caller that moves the panel
 * and redraws in the same turn, before the resize observers here have had a frame to notice.
 */
export const invalidateOverlayControlsEdge = (): void => {
  worldRightEdge = null
}

/**
 * {@link localControlsRightEdge}, measured only after a change that can move it: Wplace's DOM, a
 * resize of the window or of a box it reads, or the panel's glide. Every map frame asks for it, and
 * measuring after that frame's style writes would force a layout each time.
 */
const worldControlsRightEdge = (): number => {
  if (worldRightEdge !== null && performance.now() >= trackRightEdgeUntil) return worldRightEdge
  if (rightEdgeSizes === null) {
    rightEdgeSizes = new ResizeObserver(invalidateOverlayControlsEdge)
    onWplaceLayoutChange(invalidateOverlayControlsEdge)
    window.addEventListener('resize', invalidateOverlayControlsEdge)
  }
  worldRightEdge = localControlsRightEdge()
  const sized = [
    findWplaceRightControls(),
    document.getElementById(ALLIANCE_RAIL_ID),
    document.getElementById(PANEL_ID),
  ].filter((element) => element !== null)
  if (
    sized.length !== sizedForRightEdge.length ||
    sized.some((element, index) => element !== sizedForRightEdge[index])
  ) {
    rightEdgeSizes.disconnect()
    for (const element of sized) rightEdgeSizes.observe(element)
    sizedForRightEdge = sized
  }
  return worldRightEdge
}

/** Where map-anchored controls may be drawn and where they must stay. */
interface ControlViewport {
  /** What is visible: an anchor outside it has nothing on screen to point at. */
  readonly clipLeft: number
  readonly clipTop: number
  readonly clipRight: number
  readonly clipBottom: number
  /** Where controls are clamped to. */
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

const worldControlViewport = (): ControlViewport => ({
  clipLeft: 0,
  clipTop: 0,
  clipRight: window.innerWidth,
  clipBottom: window.innerHeight,
  left: LEFT_INSET,
  top: EDGE,
  right: worldControlsRightEdge(),
  bottom: window.innerHeight - EDGE,
})

const allianceControlViewport = (stage: HTMLElement): ControlViewport | null => {
  const box = stage.getBoundingClientRect()
  const viewport = {
    clipLeft: Math.max(0, box.left),
    clipTop: Math.max(0, box.top),
    clipRight: Math.min(window.innerWidth, box.right),
    clipBottom: Math.min(window.innerHeight, box.bottom),
    left: Math.max(LEFT_INSET, box.left + LEFT_INSET),
    top: Math.max(EDGE, box.top + allianceRailTop(stage, EDGE, GAP)),
    right: Math.min(localControlsRightEdge(), box.right - LEFT_INSET),
    bottom: Math.min(window.innerHeight - EDGE, box.bottom - EDGE),
  }
  return viewport.right - viewport.left >= RAIL_BUTTON &&
    viewport.bottom - viewport.top >= RAIL_BUTTON
    ? viewport
    : null
}

interface Point {
  readonly x: number
  readonly y: number
}

/** Where the overlay's top-right corner sits on screen, or null when none of it is in view. */
const cornerOnScreen = (
  template: PlacedTemplate,
  projection: ScreenProjection,
  viewport: ControlViewport,
): Point | null => {
  // Follow the placement preview while one is running: the overlay is painted at the preview
  // origin, and a button left at the durable origin points at nothing.
  const preview = previewOriginFor(template.id)
  const topLeft = projection.pointFor(
    preview?.x ?? template.originX,
    preview?.y ?? template.originY,
  )
  // One projection, then the size in CSS pixels. Projecting the far corner separately lets the two
  // calls resolve to different wrapped copies of the world for a template near the seam, which
  // produces a box spanning the screen and defeats the check below.
  const scale = projection.pixelsPerCanvasPixel
  const right = topLeft.x + template.width * scale.x
  const bottom = topLeft.y + template.height * scale.y
  // Projection never fails for a coordinate that is merely off-screen, so without this every
  // template in the store, including ones on the far side of the world, would clamp a button into
  // the viewport and pile them all onto the same corner, where only the last is clickable.
  if (right < viewport.clipLeft || topLeft.x > viewport.clipRight) return null
  if (bottom < viewport.clipTop || topLeft.y > viewport.clipBottom) return null
  return { x: right, y: topLeft.y }
}

/**
 * Where a column of `height` hangs off an overlay's corner, or null when the viewport is too short.
 *
 * Clamped into the viewport, so a template hanging off an edge keeps reachable controls rather than
 * losing them exactly when you want to bring it back.
 */
const railOrigin = (corner: Point, viewport: ControlViewport, height: number): Point | null =>
  viewport.bottom - viewport.top < height
    ? null
    : {
        x: Math.min(
          Math.max(corner.x + ANCHOR_OFFSET, viewport.left),
          viewport.right - RAIL_BUTTON,
        ),
        y: Math.min(
          Math.max(corner.y, viewport.top),
          Math.max(viewport.top, viewport.bottom - height),
        ),
      }

/** Position map-following controls without creating one compositor layer per visible template. */
const positionFloatingControl = (control: HTMLElement, { x, y }: Point): void => {
  const left = `${x}px`
  const top = `${y}px`
  if (control.style.left !== left) control.style.left = left
  if (control.style.top !== top) control.style.top = top
}

/** The menu's last natural size. */
let menuBox: { width: number; height: number } = { width: 0, height: 0 }
/** The viewport `menuBox` was measured in, so a rotation or a resize is the thing that re-measures. */
let measuredFor: { width: number; height: number } = { width: 0, height: 0 }

const invalidateMenuMeasurement = (): void => {
  measuredFor = { width: 0, height: 0 }
}

/**
 * Hang the menu off its gear on whichever side has room, capped to the viewport.
 *
 * Measured when it is built, when its content expands, and when the viewport changes under it.
 * Both dimensions are viewport-relative, so a size cached at build time alone would be clamped
 * against a viewport it no longer belongs to. But measuring every frame means reading after
 * writing every frame, which is the forced layout the batched frame avoids, and a panning map
 * writes on every one of them. What is measured is the size the menu wants; what it gets is that,
 * capped to the room on whichever side it goes, by arithmetic rather than another read.
 */
const placeMenu = (menu: HTMLElement, gear: Point, viewport: ControlViewport): void => {
  if (measuredFor.width !== window.innerWidth || measuredFor.height !== window.innerHeight) {
    menu.style.width = NATURAL_WIDTH
    menu.style.maxHeight = NATURAL_MAX_HEIGHT
    const box = menu.getBoundingClientRect()
    menuBox = { width: box.width, height: box.height }
    measuredFor = { width: window.innerWidth, height: window.innerHeight }
  }
  const rightSpace = viewport.right - (gear.x + RAIL_BUTTON + GAP)
  const leftSpace = gear.x - GAP - Math.max(EDGE, viewport.left)
  const openRight = menuBox.width <= rightSpace || rightSpace >= leftSpace
  const width = Math.min(menuBox.width, Math.max(0, openRight ? rightSpace : leftSpace))
  const height = Math.min(menuBox.height, viewport.bottom - viewport.top)
  menu.style.width = `${width}px`
  // Grow out of the gear: the side it hangs from is the side it scales toward.
  menu.style.transformOrigin = openRight ? 'left top' : 'right top'
  menu.style.left = `${openRight ? gear.x + RAIL_BUTTON + GAP : gear.x - GAP - width}px`
  menu.style.maxHeight = `${height}px`
  menu.style.top = `${Math.min(Math.max(gear.y, viewport.top), viewport.bottom - height)}px`
}

let openFor: string | null = null
/** The menu we built, held by reference: identity is ours to keep, not to look up by id. */
let menuNode: HTMLElement | null = null
/**
 * Which template {@link menuNode} was built for.
 *
 * Not `menuNode.dataset`: page-owned markers are not identity, and a host stripping that attribute
 * would make the owner `undefined`, so a pending draft would be rebuilt away instead of flushed.
 */
let menuOwner: string | null = null
/** The action rail the last build produced, so a host swapping or removing one is a rebuild. */
let railActions: HTMLElement[] = []
/** A control an action in this turn has asked for: always honoured once the build produces it. */
let focusRequest: string | null = null
/**
 * Our own gear buttons, by template id.
 *
 * The page owns the document and can mint an element with any id it likes; looking ours up with
 * `getElementById` every frame would let it substitute a convincing fake in the exact spot the
 * user expects a control.
 */
const buttons = new Map<string, CaelestisRailControl>()

interface PlacementRail {
  readonly apply: CaelestisRailControl
  readonly cancel: CaelestisRailControl
}

const placementRails = new Map<string, PlacementRail>()
/** Surface whose controls currently occupy the shared floating-control host. */
let controlSurface: string | null = null
/**
 * The last render's repaint callback, so a teardown can still finish a write.
 *
 * A gesture interrupted by the map going away, or by the page tearing the menu off, has a value
 * the user chose and no element left to deliver a `change` from.
 */
let lastRerender: (() => void) | null = null
const rangeGestures = createRangeGestures()

const isAnyColourPickerOpen = (): boolean =>
  (menuNode?.shadowRoot?.querySelector('[data-caelestis-colour-picker]:popover-open') ?? null) !==
  null

/**
 * Still on the page.
 *
 * Not "in our root", not "parented where we put it": those ask whether the host adopted our node
 * into an iframe or reparented it under a container of its own, which is deliberate behaviour no
 * page has. A node the page removed (a re-render, a route change) is what actually happens.
 */
const onPage = (node: Node | null | undefined): boolean => node?.isConnected === true

let glideTimer: number | undefined

/**
 * Brief window in which the controls `localControlsRightEdge` clamps (gear buttons, the open
 * menu, rail actions, placement apply/cancel) tween `left`/`top` instead of teleporting, so they
 * follow the panel drawer in lockstep. Outside the window the property is left untouched: map
 * pans must keep tracking exactly, which a lingering transition would smear.
 */
export const glideOverlayControls = (durationMs: number): void => {
  if (glideTimer !== undefined) {
    clearTimeout(glideTimer)
    glideTimer = undefined
  }
  trackRightEdgeUntil = performance.now() + Math.max(0, durationMs) + SETTLE_MARGIN_MS
  invalidateOverlayControlsEdge()
  const controls = [
    ...buttons.values(),
    ...railActions,
    ...(menuNode === null ? [] : [menuNode]),
    ...[...placementRails.values()].flatMap((rail) => [rail.apply, rail.cancel]),
  ]
  if (durationMs <= 0 || prefersReducedMotion() || controls.length === 0) return
  const transition = `left ${durationMs}ms var(--caelestis-ease-smooth-out, ease-out), top ${durationMs}ms var(--caelestis-ease-smooth-out, ease-out)`
  for (const control of controls) control.style.transition = transition
  glideTimer = window.setTimeout(() => {
    glideTimer = undefined
    for (const control of controls) {
      if (control.isConnected) control.style.transition = ''
    }
  }, durationMs + SETTLE_MARGIN_MS)
}

const overlayRailControl = (
  model: RailControlModel,
  control: string,
  activate: () => void,
): CaelestisRailControl => {
  const element = mountRailButton({ model, activate, hostClick: true })
  element.dataset[CONTROL] = control
  Object.assign(element.style, {
    position: 'fixed',
    width: `${RAIL_BUTTON}px`,
    height: `${RAIL_BUTTON}px`,
    zIndex: BUTTON_Z,
  })
  return element
}

const removeButton = (id: string): void => {
  buttons.get(id)?.remove()
  buttons.delete(id)
}

const removePlacementRail = (id: string): void => {
  const rail = placementRails.get(id)
  if (rail !== undefined) {
    for (const control of [rail.apply, rail.cancel]) {
      // Instant when the map detached them; the swap-out animates only while they are on the page.
      if (control.isConnected) closeSurface(control, () => control.remove())
      else control.remove()
    }
  }
  placementRails.delete(id)
}

/** Write out `id`'s drafts through the last render's repaint. */
const flush = (id: string): void => {
  if (lastRerender !== null) flushDrafts(id, lastRerender)
}

const forget = (id: string): void => {
  removePlacementRail(id)
  forgetWrites(id)
  forgetActions(id)
}

/** Every template this module still remembers anything about, whether or not it has a button. */
const remembered = (): Set<string> =>
  new Set([...buttons.keys(), ...placementRails.keys(), ...writtenIds(), ...actionIds()])

const menuHost = (rerender: () => void): MenuHost => ({
  rerender,
  openFor: () => openFor,
  close: closeOverlayMenu,
  handBack,
  refocus: (id, control) => {
    if (openFor === id && menuOwner === id && menuNode !== null)
      focusControl(builtControl(menuNode, control))
  },
})

/** Close the menu from one of its own exits, and put the keyboard back on its gear. */
const dismiss = (id: string, rerender: () => void): void => {
  closeOverlayMenu()
  handBack(id)
  rerender()
}

interface BuiltOverlayMenu {
  readonly menu: HTMLElement
  readonly actions: readonly HTMLElement[]
}

/** Svelte owns the visible menu and its separately positioned action rail. */
const buildMenu = (template: PlacedTemplate, rerender: () => void): BuiltOverlayMenu => {
  const { id } = template
  const actions = overlayActions(template, menuHost(rerender)).map(
    ({ model, control, activate }) => {
      const action = overlayRailControl(model, control, activate)
      action.setAttribute('data-caelestis-rail-action', '')
      return action
    },
  )
  const menu = document.createElement('caelestis-overlay-controls')
  menu.id = MENU_ID
  menu.dataset.caelestisTemplate = id
  menu.setAttribute('role', 'dialog')
  menu.setAttribute('aria-label', `${template.name} display options`)
  menu.model = overlayModel(template)
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: MENU_Z,
    width: NATURAL_WIDTH,
    maxHeight: NATURAL_MAX_HEIGHT,
  })
  applyWplaceTheme(menu)
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    escapeHandled = event
    if (event.composedPath()[0] !== menu) return
    dismiss(id, rerender)
    event.preventDefault()
  })
  const appearance = {
    ...templateAppearanceStore(id, rerender),
    layout: (settled: boolean) => {
      // A group accordion is animating: re-measuring now would cache a mid-animation height, so
      // uncap the menu and let the box follow its content until the settle event re-measures.
      if (settled) invalidateMenuMeasurement()
      else menuBox.height = window.innerHeight
      rerender()
    },
  }
  menu.addEventListener('caelestis-overlay-intent', (event) => {
    const intent = (event as CustomEvent<OverlayControlsIntent>).detail
    switch (intent.type) {
      case 'update-artwork':
        requestTemplateArtworkUpdate(id, rerender)
        break
      case 'close':
        dismiss(id, rerender)
        break
      case 'appearance':
        handleAppearanceIntent(appearance, intent.intent)
        break
    }
  })
  // The Svelte element renders its sliders after connection, so they exist one task later.
  setTimeout(() => {
    if (!menu.isConnected || menuOwner !== id) return
    for (const input of menu.shadowRoot?.querySelectorAll<HTMLInputElement>(
      'input[type="range"]',
    ) ?? []) {
      if (input.disabled || input.getAttribute('aria-disabled') === 'true') continue
      rangeGestures.bind(input, () => {}, {
        // After the element has dispatched its own commit for the gesture's last value, so the
        // rebuild the held slider deferred sees it.
        afterSettle: () => setTimeout(() => lastRerender?.(), 0),
      })
    }
  }, 0)
  return { menu, actions }
}

/**
 * Escape closes the menu wherever focus is.
 *
 * Listening only on the menu would lose the keyboard exit after the one interaction the menu is
 * built to survive: clicking the map to look at what you just changed.
 */
let escapeWatch: AbortController | null = null
/** The Escape this menu has already answered, so the window listener does not answer it twice. */
let escapeHandled: KeyboardEvent | null = null

const watchEscape = (rerender: () => void): void => {
  if (escapeWatch !== null) return
  escapeWatch = new AbortController()
  window.addEventListener(
    'keydown',
    (event) => {
      const id = openFor
      if (event.key !== 'Escape' || id === null) return
      // Our own marker, not `defaultPrevented`: any other page listener preventing Escape would
      // otherwise read as "this menu handled it" and disable the exit entirely.
      if (escapeHandled === event) return
      // `move.ts` listens in capture, so a running placement has already answered this Escape by
      // the time it bubbles here, and answering it again unwinds two layers on one key press.
      if (alreadyAnswered(event)) return
      if (event.target instanceof Node && menuNode?.contains(event.target) === true) return
      // The native modal owns Escape until its close event settles the answer.
      if (isConfirmingDelete()) return
      dismiss(id, rerender)
    },
    { signal: escapeWatch.signal },
  )
}

const openOverlayMenu = (id: string, rerender: () => void): void => {
  openFor = id
  // Hide is disabled while a delete runs, and a disabled control cannot take focus, so reopening a
  // condemned template's menu would leave the keyboard outside the dialog it just opened.
  //
  // And not at all while something is being placed. A placement started behind an open menu is
  // refused, because `move.ts` treats dialog controls as page controls and the placement's own keys
  // would be ignored; opening a menu behind a running placement is the same hazard arriving from
  // the other side. A placement started from the panel leaves every gear clickable, and the
  // keyboard landing on Hide turns the placement's Enter into a Hide, hiding the very overlay being
  // positioned, with no watch armed to notice.
  focusRequest = isMoving() ? null : templateBusy(id, 'deleting') ? 'close' : 'hide'
  watchEscape(rerender)
  rerender()
  log(`overlay menu opened for ${id}`)
}

/** Open or close the menu for one template, from the keyboard. */
export const toggleOverlayMenu = (id: string): void => {
  if (openFor === id) dismiss(id, redraw)
  else openOverlayMenu(id, redraw)
}

export const refreshOverlayMenu = (): void => {
  lastRerender?.()
}

/**
 * Put the keyboard back on the gear that opened the menu, unless something is being placed.
 *
 * Taking it *off* a gear is not this function's job: `renderFrame` enforces that every frame,
 * however focus got there.
 */
const handBack = (id: string): void => {
  if (isMoving()) return
  const button = buttons.get(id)
  ;(button?.shadowRoot?.querySelector<HTMLButtonElement>('button') ?? button)?.focus()
}

const removeRailActions = (): void => {
  for (const action of railActions) action.remove()
  railActions = []
}

const placementModels = (finishing: boolean) =>
  ({
    apply: {
      id: 'placement-apply',
      label: 'Apply template position',
      pressed: true,
      disabled: finishing,
    },
    cancel: {
      id: 'placement-cancel',
      label: 'Cancel template move',
      pressed: false,
      disabled: finishing,
    },
  }) satisfies Record<keyof PlacementRail, RailControlModel>

const placementRailFor = (id: string, host: HTMLElement): PlacementRail => {
  const existing = placementRails.get(id)
  if (existing !== undefined && onPage(existing.apply) && onPage(existing.cancel)) {
    if (existing.apply.parentElement !== host) host.append(existing.apply, existing.cancel)
    return existing
  }
  removePlacementRail(id)
  const models = placementModels(isFinishing())
  const placementAction = (
    model: RailControlModel,
    control: string,
    finish: () => Promise<unknown>,
  ): CaelestisRailControl => {
    const action = overlayRailControl(model, control, () => {
      if (movingId() !== id || isFinishing()) return
      void finish()
      lastRerender?.()
    })
    action.setAttribute('data-caelestis-placement-action', '')
    return action
  }
  const rail = {
    apply: placementAction(models.apply, 'apply-move', commitMove),
    cancel: placementAction(models.cancel, 'cancel-move', abortMove),
  }
  placementRails.set(id, rail)
  host.append(rail.apply, rail.cancel)
  openSurface(rail.apply)
  openSurface(rail.cancel)
  return rail
}

const closeOverlayMenu = (): void => {
  escapeWatch?.abort()
  escapeWatch = null
  rangeGestures.releaseAll()
  // Closed before anything is flushed: settling a draft repaints synchronously, and a menu still
  // claiming to be open is rebuilt by that repaint for an appearance it is about to lose.
  const closing = openFor
  openFor = null
  // A keyboard gesture can have a value pending and no release yet; removing the focused input
  // sends that release somewhere else.
  if (closing !== null) flush(closing)
  focusRequest = null
  const node = menuNode
  menuNode = null
  menuOwner = null
  // The close animates out; a reopen builds a fresh node, so nothing here has to wait for it.
  if (node !== null) closeSurface(node, () => node.remove())
  for (const action of railActions) closeSurface(action, () => action.remove())
  railActions = []
}

/**
 * End any gesture, and take the menu off the page, without closing it.
 *
 * Slider values are not rescued here: an in-progress value lives in the drafts, so it survives
 * every teardown by never having been in the element to begin with. What the teardown owns is that
 * the gesture is over, because the thing that would have delivered its release is going.
 */
const dropMenu = (): void => {
  rangeGestures.releaseAll()
  if (openFor !== null) flush(openFor)
  // Flushing a draft can synchronously rerender and perform this same teardown first.
  menuNode?.remove()
  menuNode = null
  menuOwner = null
  removeRailActions()
}

/**
 * Remove the shared floating controls while their current rendering host is unavailable, without
 * forgetting anything about the templates. `openFor` survives, so the menu comes back with the map.
 */
export const detachOverlayControls = (): void => {
  dropMenu()
  for (const [, button] of buttons) button.remove()
  buttons.clear()
  for (const id of placementRails.keys()) removePlacementRail(id)
}

/**
 * Drop the controls of every template not in `live`, and everything remembered about it.
 *
 * Only for templates that have actually gone: from this menu, from the panel, or from another
 * tab's reconciliation. A frame where the *map* is missing is {@link detachOverlayControls}:
 * MapLibre detaches and re-attaches its canvas, and treating that as "every template ceased to
 * exist" throws away in-flight write ordering and pending failures for templates that are all
 * still there.
 */
const sweepControls = (live: ReadonlySet<string>): void => {
  // Over everything remembered, not just what has a button: a template panned out of view has
  // already lost its button, so deleting it while off-screen would strand its intent, queue and
  // failure state for the rest of the session, and hand them back if that id ever reappeared.
  for (const id of remembered()) {
    if (live.has(id)) continue
    removeButton(id)
    forget(id)
  }
  if (openFor !== null && !live.has(openFor)) closeOverlayMenu()
}

/** The control carrying `key`, found by scanning rather than by building a selector from it. */
const controlIn = (menu: HTMLElement, key: string): HTMLElement | null => {
  const root = menu.shadowRoot
  for (const scope of root === null ? [menu] : [menu, root]) {
    for (const candidate of scope.querySelectorAll('[data-caelestis-control]')) {
      if (candidate instanceof HTMLElement && candidate.dataset[CONTROL] === key) return candidate
    }
  }
  return key === 'close' ? (root?.querySelector<HTMLElement>('[aria-label="Close"]') ?? null) : null
}

const builtControl = (menu: HTMLElement, key: string): HTMLElement | null =>
  controlIn(menu, key) ?? railActions.find((action) => action.dataset[CONTROL] === key) ?? null

const deepActiveElement = (): HTMLElement | null => {
  let active = document.activeElement
  while (active instanceof HTMLElement) {
    const nested = active.shadowRoot?.activeElement
    if (!(nested instanceof HTMLElement)) break
    active = nested
  }
  return active instanceof HTMLElement ? active : null
}

const focusControl = (control: HTMLElement | null): void => {
  const target = control?.shadowRoot?.querySelector<HTMLElement>('[data-caelestis-control], button')
  ;(target ?? control)?.focus()
}

const gearModel = (template: PlacedTemplate): RailControlModel => ({
  id: 'overlay-menu',
  label: `${template.name} display options`,
  pressed: openFor === template.id,
  expanded: openFor === template.id,
  controls: MENU_ID,
  popup: 'dialog',
})

const mountGear = (
  template: PlacedTemplate,
  host: HTMLElement,
  rerender: () => void,
): CaelestisRailControl => {
  const { id } = template
  const gear = overlayRailControl(gearModel(template), 'open-menu', () => {
    if (openFor === id) dismiss(id, rerender)
    else openOverlayMenu(id, rerender)
  })
  gear.id = `${BUTTON_PREFIX}${id}`
  gear.setAttribute('aria-haspopup', 'dialog')
  // The keyboard can arrive here without a frame (Tab produces none), and the rule that keeps it
  // off a gear during a placement runs in the render. Focus is the one event every arrival has in
  // common, so it is answered where it happens as well as where it is stated.
  gear.addEventListener('focus', () => {
    if (isMoving()) gear.blur()
  })
  host.appendChild(gear)
  buttons.set(id, gear)
  return gear
}

/**
 * Rebuild the open menu from state when what it draws has changed, keeping scroll and focus.
 *
 * Contents change only when {@link menuSignature} says so, so the camera never pulls a control out
 * from under the pointer.
 */
const syncMenu = (template: PlacedTemplate, host: HTMLElement, rerender: () => void): void => {
  const signature = menuSignature(template)
  // Only a drag *in this template's own menu* outranks a rebuild, and only while that menu is still
  // on the page. A rebuild under the pointer replaces the range element before it fires `change`,
  // losing the value. Holding A's slider with one finger and tapping B's gear with another
  // otherwise keeps A's menu, and A's handlers, parked beside B; and a menu the page has removed
  // could never be rebuilt at all while its slider stayed held.
  const stale =
    menuNode === null || !onPage(menuNode) || railActions.some((action) => !onPage(action))
  // The value survives in the drafts, but the element that would have delivered the gesture's
  // release does not, so the gesture ends here. That covers the page tearing the menu off, and a
  // second touch opening another template's menu while the first is still being dragged, where the
  // draft belongs to whoever the menu was for a moment ago.
  const previousOwner = menuOwner
  // The owner changing settles the previous owner's gestures whether or not a slider was held: a
  // touch browser need not focus a button, so switching menus can produce no blur at all.
  if (previousOwner !== null && previousOwner !== template.id) {
    rangeGestures.releaseAll()
    flush(previousOwner)
  } else if (stale && rangeGestures.isHeldWithin(menuNode)) {
    rangeGestures.releaseAll()
    flush(template.id)
  }
  const dragging =
    !stale &&
    menuOwner === template.id &&
    // *Any* of them: two pointers can be down at once on a touch device, and rebuilding when the
    // first is released takes the second one's element away mid-gesture. The picker lives outside
    // the menu, but its anchor is inside it and must remain attached for the same duration.
    (rangeGestures.isHeldWithin(menuNode) || isAnyColourPickerOpen())
  if (dragging || (!stale && menuNode?.dataset.caelestisSignature === signature)) return
  // Rebuilt from state, never patched, and never carrying a node over: the menu's structure depends
  // on what it draws, and anything kept in the old element is either lost or, worse, re-parented
  // under a different template.
  const previous = menuNode
  // A same-template re-render mounts the replacement already open: an entrance transition on every
  // signature change would flicker mid-edit. Only a genuinely new open animates in.
  const opening = previous === null || previousOwner !== template.id || !onPage(previous)
  // Sampled before anything is discarded: removing the node takes the keyboard with it.
  const scrollTop = previous?.scrollTop ?? 0
  const active = deepActiveElement()
  const focusedKey =
    active !== null &&
    (rangeGestures.isHeldWithin(previous) ||
      previous?.contains(document.activeElement) === true ||
      railActions.some((action) => action.contains(document.activeElement)))
      ? (active.dataset[CONTROL] ?? null)
      : null
  previous?.remove()
  removeRailActions()
  const built = buildMenu(template, rerender)
  const menu = built.menu
  menuNode = menu
  railActions = [...built.actions]
  invalidateMenuMeasurement()
  // Stamped from what was just built, not from what was sampled.
  menu.dataset.caelestisSignature = menuSignature(template)
  menuOwner = template.id
  if (!opening) {
    menu.dataset.state = 'open'
    for (const action of railActions) action.dataset.state = 'open'
  }
  host.append(menu, ...railActions)
  if (opening) {
    openSurface(menu)
    for (const [index, action] of railActions.entries()) {
      action.style.setProperty('--rail-action-index', String(index))
      openSurface(action)
    }
  }
  // Svelte custom elements finish their first render after connection. The same-task geometry
  // pass can therefore see a zero-height host and cache that collapsed size for the viewport.
  // Measure once more after connection so a static map does not leave the menu invisible.
  setTimeout(() => {
    if (menuNode !== menu || menuOwner !== template.id) return
    invalidateMenuMeasurement()
    rerender()
  }, 0)
  menu.scrollTop = scrollTop
  // Focus this module *asks* for is dropped while something is being placed; focus it merely finds
  // is kept. An action that asks (opening the delete question) can be deferred by a held slider,
  // which suppresses the rebuild that would consume it, and a placement can begin in the meantime.
  // Applying it then is this module moving the keyboard off a running placement, which is not the
  // same as the user having left it inside the menu.
  const wanted = (isMoving() ? null : focusRequest) ?? focusedKey
  // A control can leave between the request and the rebuild (a slider that only exists for some
  // appearances, a Hide disabled by a delete). The header close button is always there and never
  // disabled, so it is where the keyboard lands when what was asked for has gone.
  const restore = (): void => {
    if (menuNode === null || menuOwner !== template.id) return
    focusControl(
      wanted === null ? null : (builtControl(menuNode, wanted) ?? controlIn(menuNode, 'close')),
    )
  }
  restore()
  // Again once the element has rendered, for a control its first render had not produced yet.
  if (wanted !== null) setTimeout(restore, 0)
  focusRequest = null
}

/**
 * Draw the gears, and the menu when it is open, positioned from the overlays' own bounds.
 *
 * Called every frame, because the overlays move with the map. Positions are written every frame;
 * contents only when they change.
 */
const renderFrame = (
  rerender: () => void,
  mapCanvas: HTMLCanvasElement,
  templates: readonly PlacedTemplate[],
  live: ReadonlySet<string>,
  projection: ScreenProjection | null,
  host: HTMLElement,
  viewport: ControlViewport | null,
): void => {
  // Forget what has genuinely gone even on a frame with no map: returning early leaves a deleted
  // template's delete question and failures behind, ready to be handed to the next record that
  // takes its durable id.
  sweepControls(live)
  const openTemplate = openFor === null ? undefined : templateFor(openFor)
  if (openTemplate !== undefined && !isTemplateVisible(openTemplate)) closeOverlayMenu()
  if (mapCanvas.parentElement === null) {
    // No map to anchor to right now. The templates that remain have not gone anywhere, and neither
    // has anything in flight for them.
    detachOverlayControls()
    return
  }
  // A held control that left the page cannot deliver its release. Retire only disconnected
  // controls, so another active pointer keeps its own capture and fallback.
  rangeGestures.releaseDisconnected(onPage)
  // Only when a gesture's own control has gone.
  if (
    openFor !== null &&
    menuNode !== null &&
    !rangeGestures.isHeldWithin(menuNode) &&
    !isAnyColourPickerOpen()
  )
    flush(openFor)
  // While something is being placed, the keyboard is not on a gear.
  //
  // `move.ts` drives a placement from the window and ignores keys aimed at a page control, so a gear
  // holding focus costs the placement both of its keys: Escape does nothing, and Enter activates the
  // gear, opening or closing this menu instead of applying the placement. A click that starts a
  // placement, a close handing the keyboard back, a menu opened behind a running placement, and a
  // tap that changed no focus at all are four arrivals at the same state, so the rule is stated
  // once, here, where it holds however focus got there.
  if (isMoving()) {
    for (const [, gear] of buttons) if (gear === document.activeElement) gear.blur()
  }
  const placing = movingId()
  stopHiddenPlacement(() => lastRerender?.())
  for (const template of templates) expireFailures(template.id)
  // Sample every frame-wide geometry input before writing any control positions. Interleaving the
  // panel rectangle read with each template's left/top writes forces one layout per visible
  // template while the main panel is open.
  const placements = templates.map((template) => ({
    template,
    // Hidden templates are managed from the main menu. This uses effective visibility because a
    // template can keep its own switch on while a server or folder above it hides the whole branch.
    // A local trigger for something no longer drawn leaves chrome over unrelated map pixels.
    corner:
      projection === null || viewport === null || !isTemplateVisible(template)
        ? null
        : cornerOnScreen(template, projection, viewport),
  }))
  for (const { template, corner } of placements) {
    const { id } = template
    if (placing === id) {
      removeButton(id)
      const origin =
        corner === null || viewport === null
          ? null
          : railOrigin(corner, viewport, RAIL_BUTTON * 2 + GAP)
      if (origin === null) {
        removePlacementRail(id)
        continue
      }
      const rail = placementRailFor(id, host)
      const models = placementModels(isFinishing())
      rail.apply.model = models.apply
      rail.cancel.model = models.cancel
      positionFloatingControl(rail.apply, origin)
      positionFloatingControl(rail.cancel, { x: origin.x, y: origin.y + RAIL_BUTTON + GAP })
      continue
    }
    removePlacementRail(id)
    let button = buttons.get(id)
    if (button !== undefined && !onPage(button)) {
      // Removed, not merely forgotten. Left in place it is a second live control with our id and
      // our handlers, and it outlives the template it belongs to.
      removeButton(id)
      button = undefined
    }
    const open = openFor === id
    if (corner === null || viewport === null) {
      // The same teardown the map disappearing gets: the overlay leaving the viewport is the
      // ordinary way to look at the map while its menu is open, so it must not cost a drag its
      // value, and a rebuild is still refused under a held slider.
      if (open && menuNode !== null) {
        if (rangeGestures.isHeldWithin(menuNode)) continue
        dropMenu()
      }
      removeButton(id)
      continue
    }
    const actionCount = open ? overlayActions(template, menuHost(rerender)).length : 0
    const gearAt = railOrigin(corner, viewport, RAIL_BUTTON + actionCount * (RAIL_BUTTON + GAP))
    if (gearAt === null) {
      if (open && menuNode !== null) dropMenu()
      removeButton(id)
      continue
    }
    if (button === undefined) button = mountGear(template, host, rerender)
    else if (button.parentElement !== host) host.appendChild(button)
    // Refreshed rather than set once: a rename has to reach the tooltip and the accessible name.
    const model = gearModel(template)
    button.title = `${template.name} — display options${shortcutHint('toggle-template-menu')}`
    button.setAttribute('aria-label', model.label)
    button.model = model
    positionFloatingControl(button, gearAt)
    if (!open) continue
    syncMenu(template, host, rerender)
    if (menuNode === null) continue
    for (const [index, action] of railActions.entries()) {
      positionFloatingControl(action, {
        x: gearAt.x,
        y: gearAt.y + (index + 1) * (RAIL_BUTTON + GAP),
      })
    }
    placeMenu(menuNode, gearAt, viewport)
  }
}

/** One surface's controls in `host`, from that surface's templates. */
const renderControls = (
  rerender: () => void,
  mapCanvas: HTMLCanvasElement,
  surface: TemplateSurface,
  projection: ScreenProjection | null,
  host: HTMLElement,
  viewport: ControlViewport | null,
): void => {
  lastRerender = rerender
  const key = templateSurfaceKey(surface)
  if (controlSurface !== key) {
    detachOverlayControls()
    controlSurface = key
  }
  const catalog = localTemplates()
  const templates = catalog.filter((template) => sameTemplateSurface(template.surface, surface))
  withFrameTemplates(templates, () =>
    renderFrame(
      rerender,
      mapCanvas,
      templates,
      new Set(catalog.map((template) => template.id)),
      projection,
      host,
      viewport,
    ),
  )
}

/**
 * The world map's template controls, for the frame painted on `mapCanvas`.
 *
 * `mapCanvas` is the canvas of the frame being painted rather than a CSS-class lookup: the class is
 * wplace's to rename, and guessing it wrong would sweep every control away on a frame that painted
 * the overlay perfectly well.
 */
export const renderOverlayControls = (mapCanvas: HTMLCanvasElement): void =>
  renderControls(
    repaint,
    mapCanvas,
    WORLD_TEMPLATE_SURFACE,
    screenProjection(),
    document.body,
    worldControlViewport(),
  )

interface AllianceControlGeometry {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

/** The world template controls, through the active artboard's screen projection. */
export const renderAllianceOverlayControls = (
  rerender: () => void,
  active: ActiveAllianceSurface,
  geometry: AllianceControlGeometry,
  canvas: HTMLCanvasElement,
): void => {
  const frame = active.frame.getBoundingClientRect()
  const projection: ScreenProjection | null =
    frame.width <= 0 || frame.height <= 0 || geometry.width <= 0 || geometry.height <= 0
      ? null
      : {
          canvasBox: frame,
          pointFor: (x, y) => ({
            x: frame.left + ((x - geometry.originX) / geometry.width) * frame.width,
            y: frame.top + ((y - geometry.originY) / geometry.height) * frame.height,
          }),
          pixelsPerCanvasPixel: {
            x: frame.width / geometry.width,
            y: frame.height / geometry.height,
          },
        }
  renderControls(
    rerender,
    canvas,
    active.surface,
    projection,
    active.stage.closest<HTMLElement>(OPEN_DIALOG) ?? active.stage,
    allianceControlViewport(active.stage),
  )
}
