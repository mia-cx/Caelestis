import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import type { CaelestisRailControl, RailControlModel } from '@caelestis/ui/elements'
import { type ActiveAllianceSurface, activeAllianceSurface } from '../alliance-surface.js'
import {
  isCaptureModeActive,
  isClaimModeActive,
  onClaimEditorChange,
  stopClaimMode,
} from '../claim-editor.js'
import { claimAvailability, openClaimTool } from '../claims.js'
import { log } from '../debug.js'
import { onPresenceChange } from '../presence-client.js'
import {
  getState,
  getSurfaceAppearance,
  onlySelectedColourFor,
  onStateChange,
  setOnlySelectedColourFor,
  setState,
  setSurfaceAppearance,
} from '../settings.js'
import { shortcutHint } from '../shortcuts.js'
import { isPaintOpen, onPaintSelectionChange } from '../wplace-paint.js'
import { positionChargeForecast } from './charge-forecast.js'
import { EDGE, GAP, RAIL_BUTTON } from './metrics.js'
import { refreshOverlayMenu } from './overlay-menu.js'
import {
  ALLIANCE_PANEL_ID,
  ALLIANCE_RAIL_ID,
  allianceRailInlineEnd,
  allianceRailTop,
  PANEL_ID,
  type PanelScope,
} from './panel-scope.js'
import { mountRailButton } from './rail-button.js'
import {
  findWplaceRail,
  onWplaceLayoutChange,
  wplaceButtonBelow,
  wplaceFreeTop,
  wplaceRailGap,
} from './wplace-rail.js'

/**
 * Our rail beside Wplace's, and the alliance editor's rail beside its artboard.
 *
 * **Their rail is their own markup**, not a MapLibre control — `.maplibregl-ctrl-top-right` is
 * empty — and Svelte re-renders it at will. So our rail is our own container positioned against
 * theirs: anything we put inside theirs is on loan, anything we position against it is not.
 *
 * Every button is found by id rather than kept: the buttons are also the recovery path after the
 * page drops one, so each factory returns the one already in the document.
 */

/** What the rail asks of the panel its buttons open. */
interface RailPanel {
  readonly isOpen: (scope: PanelScope) => boolean
  readonly toggleWorld: () => void
  readonly toggleAlliance: (active: ActiveAllianceSurface) => void
  /** Inset the artboard for an open alliance drawer, before the rail lines up beside it. */
  readonly insetAllianceDrawer: (active: ActiveAllianceSurface) => void
}

const BUTTON_ID = 'caelestis-rail-button'
const COLOUR_MODE_ID = 'caelestis-colour-mode'
const MISMATCH_MODE_ID = 'caelestis-mismatch-mode'
const PRESENCE_MODE_ID = 'caelestis-presence-mode'
const CLAIM_TOOL_ID = 'caelestis-claim-tool-mode'
const RAIL_ID = 'caelestis-rail'
const MORE_ID = 'caelestis-rail-more'
const TRAY_ID = 'caelestis-rail-tray'
const ALLIANCE_BUTTON_ID = 'caelestis-alliance-rail-button'
const ALLIANCE_COLOUR_MODE_ID = 'caelestis-alliance-colour-mode'
const ALLIANCE_MISMATCH_MODE_ID = 'caelestis-alliance-mismatch-mode'

/**
 * Named for the alliance it was built for. From Latin `caelum` — sky, heavens — so it carries
 * "shared" and "above everything" without having to say either.
 *
 * A proper noun rather than a functional label like the buttons around it, which is right for a
 * third-party addition: it should not read as another wplace feature. The tooltip carries the
 * explanation, since "Caelestis" alone teaches a first-time user nothing.
 */
const APP_NAME = 'Caelestis'
const buttonTooltip = (): string => `${APP_NAME} — shared templates${shortcutHint('toggle-panel')}`

let panel: RailPanel | null = null
let alarmBadge = 0

const railControl = (id: string, doc: Document = document): CaelestisRailControl | null =>
  doc.getElementById(id) as CaelestisRailControl | null

const syncModel = (id: string, model: RailControlModel): void => {
  const button = railControl(id)
  if (button !== null) button.model = model
}

/**
 * wplace marks an open rail button by adding `btn-primary`, measured by opening theirs and diffing
 * the class list. Using the same class rather than a colour of our own means our button lights up
 * in whatever their theme calls primary, now and after any theme change.
 */
const panelButtonModel = (scope: PanelScope): RailControlModel => {
  const open = panel?.isOpen(scope) ?? false
  return {
    id: scope === 'alliance' ? 'alliance-panel' : 'panel',
    label: buttonTooltip(),
    pressed: open,
    expanded: open,
    controls: scope === 'alliance' ? ALLIANCE_PANEL_ID : PANEL_ID,
    ...(scope === 'world' && alarmBadge > 0 ? { badge: alarmBadge } : {}),
  }
}

/**
 * Follow the colour wplace has selected, for every overlay on the current canvas.
 *
 * On the rail rather than only in the panel because it is toggled constantly while painting, and
 * opening a panel to reach it costs more than the mode saves. It says nothing while their drawer is
 * shut — there is no selected colour then — which the tooltip carries.
 */
const colourModel = (surface: TemplateSurface = WORLD_TEMPLATE_SURFACE): RailControlModel => {
  const on = onlySelectedColourFor(surface)
  const label = on ? 'Showing only the selected colour' : 'Show only the selected colour'
  return {
    id: 'colour',
    label: `${isPaintOpen() ? label : `${label} — open wplace's paint drawer to pick one`}${shortcutHint('toggle-colour')}`,
    pressed: on,
  }
}

const mismatchModel = (): RailControlModel => {
  const on = getState().appearance.markMismatch
  const label = on ? 'Hide global mismatch markers' : 'Show global mismatch markers'
  return { id: 'mismatch', label: `${label}${shortcutHint('toggle-markers')}`, pressed: on }
}

const allianceMismatchModel = (surface: TemplateSurface): RailControlModel => {
  const on = getSurfaceAppearance(surface).markMismatch
  return {
    id: 'mismatch',
    label: `${on ? 'Hide' : 'Show'} mismatch markers on this canvas${shortcutHint('toggle-markers')}`,
    pressed: on,
  }
}

const presenceModel = (): RailControlModel => {
  const on = getState().showPresence
  return {
    id: 'presence',
    label: `${on ? 'Hide' : 'Show'} other painters and claims${shortcutHint('toggle-presence')}`,
    pressed: on,
  }
}

const claimModel = (): RailControlModel => {
  const active = isClaimModeActive()
  const capturing = isCaptureModeActive()
  const ready = claimAvailability().ready
  return {
    id: 'claim',
    label: capturing
      ? 'Leave capture mode (Esc)'
      : active
        ? 'Leave claim mode (Esc)'
        : `Claim a region${shortcutHint('claim-mode')}`,
    title:
      ready || active
        ? capturing
          ? 'Leave capture mode without capturing (Esc)'
          : active
            ? 'Leave claim mode without saving (Esc)'
            : `Claim a region: draw shapes, paths, and strokes over the map${shortcutHint('claim-mode')}`
        : 'Claim a region. Needs a connected server with painter presence and a Wplace sign-in.',
    pressed: active,
    ...(ready || active ? {} : { disabled: true }),
  }
}

const syncColourMode = (): void => syncModel(COLOUR_MODE_ID, colourModel())
const syncMismatchMode = (): void => syncModel(MISMATCH_MODE_ID, mismatchModel())
const syncPresenceMode = (): void => syncModel(PRESENCE_MODE_ID, presenceModel())
const syncClaimTool = (): void => syncModel(CLAIM_TOOL_ID, claimModel())

/** Show the panel buttons' open state and the panel shortcut's current key. */
export const syncPanelButtons = (): void => {
  syncModel(BUTTON_ID, panelButtonModel('world'))
  syncModel(ALLIANCE_BUTTON_ID, panelButtonModel('alliance'))
}

const syncAllianceModes = (active = activeAllianceSurface()): void => {
  if (active === null) return
  syncModel(ALLIANCE_COLOUR_MODE_ID, colourModel(active.surface))
  syncModel(ALLIANCE_MISMATCH_MODE_ID, allianceMismatchModel(active.surface))
}

/**
 * The unacknowledged-alarm count. Not "how many alarms are active" — that number stays lit for
 * hours on a griefed template and stops being read. This one means "something new since you last
 * looked", so it clears itself by being seen.
 */
export const setAlarmBadge = (count: number): void => {
  alarmBadge = Math.max(0, count)
  syncPanelButtons()
}

/** Every world rail button in rail order; the first ones win the slots when the column is short. */
const worldButtons = (): CaelestisRailControl[] => [
  railControl(BUTTON_ID) ??
    mountRailButton({
      id: BUTTON_ID,
      model: panelButtonModel('world'),
      activate: () => panel?.toggleWorld(),
      hostClick: true,
    }),
  railControl(COLOUR_MODE_ID) ??
    mountRailButton({
      id: COLOUR_MODE_ID,
      model: colourModel(),
      activate: () => {
        setOnlySelectedColourFor(
          WORLD_TEMPLATE_SURFACE,
          !onlySelectedColourFor(WORLD_TEMPLATE_SURFACE),
        )
        syncColourMode()
      },
    }),
  // The always-reachable switch for the global marker default.
  railControl(MISMATCH_MODE_ID) ??
    mountRailButton({
      id: MISMATCH_MODE_ID,
      model: mismatchModel(),
      activate: () => {
        const appearance = getState().appearance
        setState({ appearance: { ...appearance, markMismatch: !appearance.markMismatch } })
        syncMismatchMode()
      },
    }),
  // The always-reachable switch for other painters, so it works where there is no keyboard.
  railControl(PRESENCE_MODE_ID) ??
    mountRailButton({
      id: PRESENCE_MODE_ID,
      model: presenceModel(),
      activate: () => {
        setState({ showPresence: !getState().showPresence })
        syncPresenceMode()
      },
    }),
  // The always-reachable way into the region claim tool.
  railControl(CLAIM_TOOL_ID) ??
    mountRailButton({
      id: CLAIM_TOOL_ID,
      model: claimModel(),
      activate: () => {
        if (isClaimModeActive()) stopClaimMode()
        else openClaimTool()
        syncClaimTool()
      },
    }),
]

/** Wplace's rail spacing, last measured; kept while their rail is gone, as in the paint drawer. */
let railGap = GAP
let moreControl: CaelestisRailControl | null = null
let tray: HTMLElement | null = null

/**
 * Our own rail, beneath wplace's when they have one and in its place when they do not.
 *
 * Not appended *into* their rail: that would look native and disappear with it, and it disappears
 * exactly when the paint drawer opens, which is when these controls are most wanted. Owning the
 * container decouples the two.
 */
const railContainer = (): HTMLElement => {
  const existing = document.getElementById(RAIL_ID)
  if (existing !== null) return existing
  const el = document.createElement('div')
  el.id = RAIL_ID
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '30',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  })
  document.body.appendChild(el)
  return el
}

const trayOpen = (): boolean => tray !== null && !tray.hidden

const moreModel = (): RailControlModel => ({
  id: 'more',
  label: 'More Caelestis controls',
  popup: 'menu',
  controls: TRAY_ID,
  expanded: trayOpen(),
})

const setTrayOpen = (open: boolean): void => {
  if (tray === null || trayOpen() === open) return
  tray.hidden = !open
  if (moreControl !== null) moreControl.model = moreModel()
  if (open) {
    window.addEventListener('pointerdown', closeTrayOutside, true)
    window.addEventListener('keydown', closeTrayOnEscape)
  } else {
    window.removeEventListener('pointerdown', closeTrayOutside, true)
    window.removeEventListener('keydown', closeTrayOnEscape)
  }
}

const closeTrayOutside = (event: PointerEvent): void => {
  const target = event.target as Node
  if (tray?.contains(target) === true || moreControl?.contains(target) === true) return
  setTrayOpen(false)
}

const closeTrayOnEscape = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return
  setTrayOpen(false)
  moreControl?.focus()
}

/** The rail's last slot when the column is short: opens the buttons that did not fit. */
const moreButton = (): CaelestisRailControl => {
  moreControl ??= mountRailButton({
    id: MORE_ID,
    model: moreModel(),
    activate: () => setTrayOpen(!trayOpen()),
  })
  return moreControl
}

/**
 * The popout beside More: a row of the overflowed rail buttons, the same elements the rail would
 * have shown, so their state and handlers carry over untouched. A button in it does its job and
 * the tray closes, like a menu.
 */
const trayContainer = (): HTMLElement => {
  if (tray !== null) return tray
  tray = document.createElement('div')
  tray.id = TRAY_ID
  Object.assign(tray.style, { display: 'flex', alignItems: 'center' })
  tray.setAttribute('role', 'menu')
  tray.setAttribute('aria-label', 'More Caelestis controls')
  Object.assign(tray.style, { position: 'fixed', zIndex: '30' })
  tray.hidden = true
  tray.addEventListener('caelestis-rail-intent', () => setTrayOpen(false))
  document.body.appendChild(tray)
  return tray
}

/** Put exactly these children in this order, touching only the ones out of place. */
const place = (host: HTMLElement, children: readonly HTMLElement[]): void => {
  children.forEach((child, index) => {
    if (host.children[index] !== child) host.insertBefore(child, host.children[index] ?? null)
  })
  while (host.children.length > children.length) host.lastElementChild?.remove()
}

/** Write `top`/`right` only when they change, so an unmoved rail leaves layout clean. */
const setFixedOffset = (el: HTMLElement, top: number, right: number): void => {
  const topPx = `${top}px`
  const rightPx = `${right}px`
  if (el.style.top !== topPx) el.style.top = topPx
  if (el.style.right !== rightPx) el.style.right = rightPx
}

/**
 * Keep our rail where wplace's is, and following it when it moves.
 *
 * Read from their rail's own box rather than from a copy of their Tailwind offsets: they own that
 * layout and are free to change it. The fallback is the paint-drawer case, where their rail is
 * gone and only the Store button, when they show it while painting, is left in the corner.
 *
 * The column ends above whatever wplace button sits below it — My location, the profile button,
 * the paint drawer. Buttons that do not fit move behind More rather than into a second column,
 * because the space to the left belongs to each overlay's own controls.
 */
export const positionRail = (): void => {
  const rail = railContainer()
  // Every read comes before the first write, so measuring never forces a second layout.
  const theirRail = findWplaceRail()
  railGap = (theirRail === null ? null : wplaceRailGap(theirRail)) ?? railGap
  const gap = railGap
  const theirs = theirRail?.getBoundingClientRect()
  const beside = theirs !== undefined && theirs.width > 0
  // Fixed-position offsets use the layout viewport, which excludes the page scrollbar.
  const viewportWidth = document.documentElement.clientWidth
  const right = beside ? viewportWidth - theirs.right : EDGE
  const columnRight = viewportWidth - right
  const top = wplaceFreeTop(
    { left: columnRight - RAIL_BUTTON, right: columnRight },
    beside ? theirs.bottom + gap : EDGE,
    gap,
  )
  const below = wplaceButtonBelow({ left: columnRight - RAIL_BUTTON, right: columnRight, top })
  const floor = below === null ? window.innerHeight - EDGE : below - gap
  const slots = Math.max(1, Math.floor((floor - top + gap) / (RAIL_BUTTON + gap)))
  const buttons = worldButtons()
  const fits = slots >= buttons.length
  setFixedOffset(rail, top, right)
  place(rail, fits ? buttons : [...buttons.slice(0, slots - 1), moreButton()])
  place(trayContainer(), fits ? [] : buttons.slice(slots - 1))
  if (fits) setTrayOpen(false)
  const tray = trayContainer()
  setFixedOffset(tray, top + (slots - 1) * (RAIL_BUTTON + gap), right + RAIL_BUTTON + gap)
  const gapPx = `${gap}px`
  if (rail.style.gap !== gapPx) rail.style.gap = gapPx
  if (tray.style.gap !== gapPx) tray.style.gap = gapPx
}

let allianceRailObserver: MutationObserver | null = null

/** Line the alliance rail up with Wplace's fullscreen actions, beside an open drawer. */
export const positionAllianceRail = (active: ActiveAllianceSurface): void => {
  const wrapper = active.stage.ownerDocument.getElementById(ALLIANCE_RAIL_ID)
  if (wrapper === null) return
  const parent = wrapper.parentElement
  if (parent === null) return
  panel?.insetAllianceDrawer(active)
  wrapper.style.top = `${active.stage.offsetTop + allianceRailTop(active.stage, GAP, GAP)}px`
  wrapper.style.right = `${allianceRailInlineEnd(active.stage, parent, GAP)}px`
}

/** Take the alliance rail off the page, with the observer that kept it in place. */
export const unmountAllianceRail = (): void => {
  allianceRailObserver?.disconnect()
  allianceRailObserver = null
  document.getElementById(ALLIANCE_RAIL_ID)?.remove()
}

/** The alliance editor's rail: its drawer button and that canvas's colour and marker switches. */
export const mountAllianceRail = (active: ActiveAllianceSurface): void => {
  unmountAllianceRail()
  const doc = active.stage.ownerDocument
  const wrapper = doc.createElement('div')
  wrapper.id = ALLIANCE_RAIL_ID
  Object.assign(wrapper.style, {
    position: 'absolute',
    zIndex: '40',
    display: 'flex',
    flexDirection: 'column',
    gap: `${GAP}px`,
  } satisfies Partial<CSSStyleDeclaration>)
  wrapper.append(
    railControl(ALLIANCE_BUTTON_ID, doc) ??
      mountRailButton({
        id: ALLIANCE_BUTTON_ID,
        document: doc,
        model: panelButtonModel('alliance'),
        activate: () => panel?.toggleAlliance(active),
        hostClick: true,
        isolatePointerDown: true,
      }),
    railControl(ALLIANCE_COLOUR_MODE_ID) ??
      mountRailButton({
        id: ALLIANCE_COLOUR_MODE_ID,
        model: colourModel(active.surface),
        activate: () =>
          setOnlySelectedColourFor(active.surface, !onlySelectedColourFor(active.surface)),
      }),
    railControl(ALLIANCE_MISMATCH_MODE_ID) ??
      mountRailButton({
        id: ALLIANCE_MISMATCH_MODE_ID,
        model: allianceMismatchModel(active.surface),
        activate: () => {
          const appearance = getSurfaceAppearance(active.surface)
          setSurfaceAppearance(active.surface, {
            ...appearance,
            markMismatch: !appearance.markMismatch,
          })
        },
      }),
  )
  ;(active.stage.parentElement ?? active.stage).appendChild(wrapper)
  positionAllianceRail(active)
  syncAllianceModes(active)
  const realm = doc.defaultView
  if (realm === null) return
  realm.requestAnimationFrame(() => refreshOverlayMenu())
  allianceRailObserver = new realm.MutationObserver(() => positionAllianceRail(active))
  const viewportAttributes = { attributes: true, attributeFilter: ['class', 'style'] }
  allianceRailObserver.observe(active.frame, viewportAttributes)
  allianceRailObserver.observe(active.stage, viewportAttributes)
}

/**
 * Put our rail beside Wplace's and keep every button's state current. The rail is rendered by
 * Wplace's own Svelte app, which is free to re-render at any moment; the layout listener only
 * notices *their* rail moving or vanishing, and `positionRail` also puts every button of ours back
 * in its slot.
 */
export const installRail = (owner: RailPanel): void => {
  panel = owner
  positionRail()
  syncPanelButtons()
  syncColourMode()
  syncMismatchMode()
  syncPresenceMode()
  syncClaimTool()
  onClaimEditorChange(syncClaimTool)
  onPresenceChange(syncClaimTool)
  onStateChange(syncMismatchMode)
  onStateChange(syncPresenceMode)
  onStateChange(syncClaimTool)
  onStateChange(syncColourMode)
  onStateChange(() => syncAllianceModes())
  // Opening wplace's paint drawer changes what the colour switches say without changing any state.
  onPaintSelectionChange(() => {
    syncColourMode()
    syncAllianceModes()
  })
  positionChargeForecast()
  onWplaceLayoutChange(() => {
    positionRail()
    positionChargeForecast()
  })
  log('rail installed beside wplace’s')
}
