import {
  sameTemplateSurface,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type {
  CaelestisPanel,
  PanelIntent,
  PanelModel,
  SettingsIntent,
} from '@caelestis/ui/elements'
import {
  cancelSurfaceClose,
  closeSurface,
  openSurface,
  surfaceCloseDurationMs,
} from '@caelestis/ui/motion'
import { onAllianceManifestChange } from '../alliance-server-sync.js'
import {
  type ActiveAllianceSurface,
  activeAllianceSurface,
  currentSurface,
  onActiveAllianceSurfaceChange,
} from '../alliance-surface.js'
import { onTemplateStudioChange } from '../application/template-studio.js'
import { cancelDestinationAdmissions } from '../application/transfer.js'
import { treeActionUsesServer } from '../application/tree-copy.js'
import { cancelTreeActionSetup } from '../application/tree-presentation.js'
import { onServerSnapshot } from '../application/tree-server-state.js'
import { onOtherBuildChange } from '../build-transfer.js'
import { onCanvasWrite } from '../canvas-write.js'
import { isClaimModeActive, onClaimEditorChange } from '../claim-editor.js'
import { claimRouter } from '../claim-routing.js'
import { openClaimTool } from '../claims.js'
import { log } from '../debug.js'
import { frameQueue } from '../frame-queue.js'
import { onArtboardPixelsChange, onHeadquartersTilesChange } from '../gl/artboard-pixels.js'
import { onViewChange, redraw, viewportCentre } from '../map-view.js'
import { onPresenceChange } from '../presence-client.js'
import { measureProfile, recordProfileCounter } from '../profile.js'
import { onServerAlarmChange } from '../server-alarms.js'
import {
  installServerConnectionRetry,
  refreshStoredServers,
  removeServer,
} from '../server-connections.js'
import { admittedManifest, primeFromCache } from '../server-manifests.js'
import { onServerStatusChange } from '../server-status.js'
import {
  getState,
  onStateChange,
  type ServerConnection,
  type State,
  setState,
} from '../settings.js'
import { onStoredValueChange } from '../stored-values.js'
import { onLocalChange } from '../templates/catalog.js'
import { pixelAccounting } from '../templates/mismatch.js'
import { onOfficialOverlaysChange } from '../templates/official-overlays.js'
import { ensureLocalTags } from '../templates/tags.js'
import { reloadTiles } from '../tile-pixels.js'
import { serverTemplateTreeKey } from '../tree-keys.js'
import { refreshAccount } from '../wplace-account.js'
import { onPaintSelectionChange } from '../wplace-paint.js'
import { onWplacePatchChange } from '../wplace-switches.js'
import {
  handleAppearanceIntent,
  surfaceAppearanceModel,
  surfaceAppearanceStore,
} from './appearance.js'
import { positionChargeForecast } from './charge-forecast.js'
import { CLEAR_OF_RAIL, EDGE, GAP } from './metrics.js'
import { mountNotificationsIn, showToast, syncToastPlacement } from './notification-host.js'
import { glideOverlayControls, invalidateOverlayControlsEdge } from './overlay-menu.js'
import { canvasWritesTouchArtboard } from './panel-progress.js'
import {
  ALLIANCE_PANEL_ID,
  AllianceDrawerInset,
  PANEL_ID,
  type PanelScope,
  PanelSessions,
  type PanelView,
  panelTitle,
} from './panel-scope.js'
import { clearClaim, flyToClaim, flyToPainter } from './presence-actions.js'
import {
  installRail,
  mountAllianceRail,
  positionAllianceRail,
  positionRail,
  syncPanelButtons,
  unmountAllianceRail,
} from './rail.js'
import {
  autoExpanded,
  disconnectingServerUrls,
  expandedServers,
  handleSettingsIntent,
  onSettingsViewChange,
  setSettingsVisible,
  settingsModel,
} from './settings-controller.js'
import { applyWplaceTheme } from './theme.js'
import {
  buildTreeView,
  clearTreeView,
  focusedTreeKey,
  handleTreeIntent,
  hasTreeView,
  installTreeView,
  markClaimedTreeStale,
  presenceField,
  refreshTreeViewProgress,
  setShowOtherClaims,
  treeViewModel,
  treeViewPresents,
} from './tree-view.js'
import { isTreeDragActive } from './tree-view-state.js'
import { retryTemplateClaims } from './work.js'

/**
 * The panel our rail button opens: the world sidebar, or a drawer beside an alliance artboard.
 * This module mounts and opens it and redraws its current view; the views' models and intents
 * live in tree-view, settings-controller and appearance.
 *
 * **wplace ships DaisyUI**, with `data-theme="custom-winter"` on `<html>`. Borrowing their
 * component classes means our surfaces inherit their theme tokens, including any theme they add
 * later. **But borrow components, never invent utilities.** Tailwind ships only the classes a
 * site actually uses, so a utility wplace has no use for is simply absent from their stylesheet —
 * which is why the first version of this panel rendered in the top-left corner with
 * `position: fixed` applied and nothing else. So **layout is inline styles**, which cannot
 * silently evaporate.
 *
 * The sidebar keeps the map interactive. Its popout opens the same menu in a modal for wider
 * template browsing, with grid mode available there. Canvas actions return to the sidebar.
 */

const maximumPanelWidth = (): number =>
  Math.min(720, Math.max(0, document.documentElement.clientWidth - 96))
const minimumPanelWidth = (): number => Math.min(260, maximumPanelWidth())
const panelWidthForViewport = (wanted: number): number =>
  Math.min(maximumPanelWidth(), Math.max(minimumPanelWidth(), wanted))

const panelSessions = new PanelSessions()
let panelSurface: TemplateSurface = WORLD_TEMPLATE_SURFACE
let panelHost: HTMLElement | null = null
let allianceStage: HTMLElement | null = null
const allianceDrawerInset = new AllianceDrawerInset()
const worldTreeVisibleListeners = new Set<() => void>()

const currentView = (): PanelView => panelSessions.view()
const panelOpen = (): boolean => panelSessions.isOpen()
const currentPanelId = (): string =>
  panelSessions.scope() === 'alliance' ? ALLIANCE_PANEL_ID : PANEL_ID
const currentPanel = (): CaelestisPanel | null =>
  document.getElementById(currentPanelId()) as CaelestisPanel | null
/** Settings belong to the whole tab, so only the world panel shows them. */
const showsSettings = (): boolean => panelSurface.kind === 'world'

/** The panel's laid-out width; a freshly connected element has no box yet, so its model's. */
const currentPanelWidth = (panel: CaelestisPanel): number =>
  panel.getBoundingClientRect().width || panel.model.width

const panelModel = (width = panelWidthForViewport(getState().panelWidth)): PanelModel => ({
  view: currentView(),
  title: panelTitle(panelSurface),
  showSettings: showsSettings(),
  width,
  minWidth: minimumPanelWidth(),
  maxWidth: maximumPanelWidth(),
  ...(currentView() === 'tree' ? treeViewModel() : {}),
  ...(currentView() === 'appearance' ? { appearance: surfaceAppearanceModel(panelSurface) } : {}),
  ...(currentView() === 'settings' && showsSettings() ? { settings: settingsModel() } : {}),
})

const notifyWorldTreeVisible = (): void => {
  if (!panelSessions.isWorldTreeVisible()) return
  for (const listener of worldTreeVisibleListeners) listener()
}

const syncSettingsVisible = (): void =>
  setSettingsVisible(panelOpen() && currentView() === 'settings')

/**
 * Redraw whatever the panel is showing when the state changes underneath it.
 *
 * **Every view, not only the tree.** A keybind is a change from outside the panel by definition,
 * so pressing `W` moved the markers and left the switch that claims to control them reading the
 * opposite.
 *
 * Skipped mid-gesture. A rename is an open text field, a drag is a row in flight, and a slider is
 * held under the pointer; replacing any of those takes the thing away from the hand using it. The
 * colour picker counts even though it is not in the panel — it is anchored to a swatch that is, so
 * rebuilding would detach it from its own anchor. Its close callback requests the deferred redraw.
 */
let owedRefresh = false
const heldPanelPointers = new Set<number>()

const refreshView = (): void => {
  markClaimedTreeStale()
  redrawView()
}

/** Whether a state change only expanded or collapsed rows; `setState` keeps other fields' identity. */
const onlyExpansionChanged = (previous: State, next: State): boolean =>
  previous.collapsed !== next.collapsed &&
  (Object.keys(next) as (keyof State)[]).every(
    (key) => key === 'collapsed' || previous[key] === next[key],
  )

/** `refreshView` for a change the claimed list cannot see, so its cached build survives. */
const redrawView = (): void => {
  if (!panelOpen()) return
  const root = document.getElementById(currentPanelId())
  if (root === null) return
  const held =
    (root.shadowRoot?.querySelector('[data-caelestis-colour-picker]:popover-open') ?? null) !==
      null ||
    isTreeDragActive() ||
    heldPanelPointers.size > 0 ||
    (root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement)
  if (held) {
    owedRefresh = true
    return
  }
  owedRefresh = false
  showView(currentView())
}

/**
 * Pay back a redraw that was declined while something was being held. Deferred by a tick because
 * every event that calls it fires *before* the thing it announces has finished letting go.
 */
const repayRefresh = (): void => {
  if (!owedRefresh) return
  setTimeout(refreshView, 0)
}

const refreshSettings = (): void => {
  if (panelOpen() && currentView() === 'settings') showView('settings')
}

/** Rebuild the main tree only, for inputs the claimed list ignores, such as the search query. */
const renderTree = (): void => {
  if (!panelOpen() || currentView() !== 'tree') return
  const panel = currentPanel()
  if (panel === null) return
  buildTreeView()
  panel.model = panelModel(currentPanelWidth(panel))
  notifyWorldTreeVisible()
}

/** Rebuild both trees: whichever is on screen, whatever closure asks. */
const rerenderTree = (): void => {
  markClaimedTreeStale()
  renderTree()
}

let manifestTreeRefreshQueued = false
const queueManifestTreeRefresh = (): void => {
  if (manifestTreeRefreshQueued) return
  manifestTreeRefreshQueued = true
  queueMicrotask(() => {
    manifestTreeRefreshQueued = false
    if (!panelOpen() || currentView() !== 'tree') return
    if (isTreeDragActive()) {
      owedRefresh = true
      return
    }
    rerenderTree()
  })
}

/** The work revision last admitted per server URL, so a claims-only change still redraws. */
const admittedWorkRevisions = new Map<string, number | undefined>()

onServerSnapshot((server, result) => {
  if (result.status !== 'admitted') return
  // Claiming a template bumps only the manifest's work revision; its rows compare unchanged.
  const revision = admittedManifest(server)?.workRevision
  const claimsChanged = admittedWorkRevisions.get(server.url) !== revision
  admittedWorkRevisions.set(server.url, revision)
  if (result.changed || claimsChanged) queueManifestTreeRefresh()
})

/** Follow a presence message by replacing only the Painters drawer; the trees do not read it. */
const refreshPresenceDrawer = (): void => {
  if (!panelOpen() || currentView() !== 'tree') return
  const panel = currentPanel()
  const work = panel?.model.work
  if (panel == null || work === undefined) return
  const { presence: _previous, ...rest } = work
  panel.model = { ...panel.model, work: { ...rest, ...presenceField() } }
}

/** Follow a pixel-progress change by updating row progress in both trees, keeping their rows. */
const refreshTreeProgress = (): void => {
  if (!panelOpen() || currentView() !== 'tree' || !hasTreeView()) return
  const panel = currentPanel()
  if (panel === null) return
  if (refreshTreeViewProgress()) panel.model = panelModel(currentPanelWidth(panel))
}

/** Move the focused-row marker without rebuilding the full template tree. */
const refreshTreeFocus = (): void => {
  if (!panelOpen() || currentView() !== 'tree' || !hasTreeView()) return
  const panel = currentPanel()
  if (panel === null) return
  if (panel.model.tree?.focusedKey === focusedTreeKey()) return
  panel.model = panelModel(currentPanelWidth(panel))
}

let lastFocusCentre: { readonly x: number; readonly y: number } | null | undefined

/** The focused row follows the view; on the world map, only when its centre moves. */
const followViewFocus = (): void => {
  if (currentSurface().kind === 'world') {
    const centre = viewportCentre()
    if (
      lastFocusCentre !== undefined &&
      (centre === null
        ? lastFocusCentre === null
        : lastFocusCentre?.x === centre.x && lastFocusCentre.y === centre.y)
    )
      return
    lastFocusCentre = centre
  }
  refreshTreeFocus()
}

const showView = (view: PanelView): void => {
  if (view === 'settings' && !showsSettings()) return
  panelSessions.setView(view)
  const panel = currentPanel()
  if (panel === null) return

  if (view === 'settings') settingsModel()
  if (view === 'tree') {
    buildTreeView()
  } else {
    clearTreeView()
    if (view === 'appearance') refreshAccount(refreshView)
  }
  panel.model = panelModel(currentPanelWidth(panel))
  syncSettingsVisible()
  notifyWorldTreeVisible()
  log(`panel view: ${view}`)
}

/**
 * Disconnect: take the server out of the list, and everything it put on this machine with it.
 * The connection's own teardown (`removeServer`) clears every per-server cache; what is left here
 * belongs to the panel and the actions it started.
 */
const disconnectServer = async (server: ServerConnection): Promise<void> => {
  if (disconnectingServerUrls.has(server.url)) return
  disconnectingServerUrls.add(server.url)
  try {
    await claimRouter().disconnect(server)
    if (treeActionUsesServer(server.url)) {
      cancelTreeActionSetup(new Error('copy destination disconnected'))
    }
    cancelDestinationAdmissions(server.url)
    await removeServer(server.url)
    expandedServers.delete(server.url)
    autoExpanded.delete(server.url)
    redraw()
    showView('settings')
  } finally {
    disconnectingServerUrls.delete(server.url)
  }
}

const handleSettings = (intent: SettingsIntent): void => {
  if (!showsSettings()) return
  if (intent.type !== 'disconnect-server') {
    handleSettingsIntent(intent)
    return
  }
  const server = getState().servers.find((candidate) => candidate.url === intent.url)
  if (server !== undefined) void disconnectServer(server)
}

/** Make room beside the alliance drawer at `width`, and line its rail up again. */
const insetAllianceDrawer = (width: number): void => {
  if (allianceStage === null) return
  allianceDrawerInset.apply(allianceStage, width, GAP)
  const active = activeAllianceSurface()
  if (active !== null) positionAllianceRail(active)
}

const handlePanelIntent = (panel: CaelestisPanel, intent: PanelIntent): void => {
  switch (intent.type) {
    case 'tree':
      handleTreeIntent(intent.intent, 'tree')
      break
    case 'work-tree':
      handleTreeIntent(intent.intent, 'claimed')
      break
    case 'work-retry':
      retryTemplateClaims(panelSurface, rerenderTree)
      break
    case 'work-visibility':
      setShowOtherClaims(intent.showOtherClaims)
      break
    case 'region-claim':
      openClaimTool()
      break
    case 'presence-fly':
      flyToPainter(intent.key)
      break
    case 'claim-fly':
      flyToClaim(intent.key)
      break
    case 'claim-clear':
      void clearClaim(intent.key, rerenderTree)
      break
    case 'navigate':
      showView(intent.view)
      break
    case 'close':
      setOpen(false)
      break
    case 'reload-tiles':
      void reloadTiles()
      break
    case 'popout':
      mountNotificationsIn(intent.open ? (panel.shadowRoot?.querySelector('dialog') ?? null) : null)
      break
    case 'resize-preview':
      insetAllianceDrawer(intent.width)
      invalidateOverlayControlsEdge()
      redraw()
      break
    case 'resize-commit':
      setState({ panelWidth: intent.width })
      insetAllianceDrawer(intent.width)
      break
    case 'appearance':
      handleAppearanceIntent(surfaceAppearanceStore(panelSurface), intent.intent)
      break
    case 'settings':
      handleSettings(intent.intent)
      break
  }
}

const buildPanel = (): CaelestisPanel => {
  const panel = (panelHost?.ownerDocument ?? document).createElement('caelestis-panel')
  const alliance = panelSessions.scope() === 'alliance'
  panel.id = currentPanelId()
  panel.setAttribute('aria-label', panelTitle(panelSurface))
  Object.assign(panel.style, {
    position: alliance ? 'absolute' : 'fixed',
    right: alliance ? '0' : `${CLEAR_OF_RAIL}px`,
    top: alliance ? `${allianceStage?.offsetTop ?? 0}px` : `${EDGE}px`,
    bottom: alliance ? '0' : `${EDGE}px`,
    zIndex: '30',
    display: 'block',
    minHeight: '0',
    overflow: 'hidden',
    borderRadius: 'var(--caelestis-radius)',
  } satisfies Partial<CSSStyleDeclaration>)
  // The drawer slide runs on the inner pane, which must clear the host's right offset to leave
  // the viewport entirely: CLEAR_OF_RAIL for the world panel, nothing for the alliance drawer.
  panel.style.setProperty('--pane-inset', alliance ? '0px' : `${CLEAR_OF_RAIL}px`)
  panel.model = panelModel()
  applyWplaceTheme(panel)
  panel.addEventListener('caelestis-panel-intent', (event) =>
    handlePanelIntent(panel, (event as CustomEvent<PanelIntent>).detail),
  )
  return panel
}

const setOpen = (next: boolean): void => {
  panelSessions.setOpen(next)
  syncPanelButtons()
  const existing = document.getElementById(currentPanelId())
  if (!panelOpen()) {
    cancelTreeActionSetup(new Error('panel closed'))
    mountNotificationsIn(null)
    if (existing !== null) closeSurface(existing, () => existing.remove())
    if (panelSessions.scope() === 'alliance') {
      allianceDrawerInset.clear()
      const active = activeAllianceSurface()
      if (active !== null) positionAllianceRail(active)
    }
    syncSettingsVisible()
    // Map-anchored controls glide into the reclaimed width in lockstep with the drawer.
    glideOverlayControls(existing === null ? 0 : surfaceCloseDurationMs(existing))
    redraw()
    syncToastPlacement(currentPanelId())
    return
  }
  // A node still running its exit transition is reused so the reopen reverses in place.
  if (existing !== null && !cancelSurfaceClose(existing)) return
  if (existing !== null) existing.dataset.state = 'open'
  insetAllianceDrawer(panelWidthForViewport(getState().panelWidth))
  const host = panelHost ?? document.body
  const panel = existing ?? buildPanel()
  if (existing === null) {
    host.appendChild(panel)
    openSurface(panel)
  }
  // The panel's measured left edge is now the map controls' right edge; they glide over to it.
  // Armed before showView, which already repositions the controls. Read from the theme token
  // Panel.element's --pane-open-dur points at: a fresh host's shadow styles attach a microtask
  // after connection, so --pane-open-dur itself still reads empty here.
  glideOverlayControls(surfaceCloseDurationMs(panel, '--caelestis-duration-medium'))
  // Refreshes skip a closed panel, so whatever the claimed list was built from may have moved.
  markClaimedTreeStale()
  showView(currentView())
  void primeFromCache(rerenderTree)
  redraw()
  syncToastPlacement(currentPanelId())
}

/** Open or close the panel for the canvas currently in front of the user. */
export const togglePanel = (): void => setOpen(!panelOpen())

/** Leave room to draw on phones, including when a desktop editing session is resized. */
const closePanelForMobileDrawing = (): void => {
  if (panelOpen() && isClaimModeActive() && window.matchMedia('(max-width: 40rem)').matches)
    setOpen(false)
}

const togglePanelFor = (scope: PanelScope): void => {
  const next = !panelSessions.isOpen(scope)
  if (scope !== panelSessions.scope()) {
    panelSessions.setOpen(next, scope)
    syncPanelButtons()
    return
  }
  setOpen(next)
}

const unmountSelectedPanel = (): void => {
  mountNotificationsIn(null)
  document.getElementById(currentPanelId())?.remove()
  syncToastPlacement(currentPanelId())
  if (panelSessions.scope() === 'alliance') allianceDrawerInset.clear()
  clearTreeView()
  syncSettingsVisible()
}

const selectAlliancePanelSurface = (active: ActiveAllianceSurface | null): void => {
  unmountAllianceRail()
  if (active === null) {
    if (panelSessions.scope() === 'alliance') unmountSelectedPanel()
    panelSessions.select('world')
    panelSurface = WORLD_TEMPLATE_SURFACE
    panelHost = document.body
    allianceStage = null
    if (panelSessions.isOpen()) setOpen(true)
    else syncPanelButtons()
    return
  }

  mountAllianceRail(active)
  const nextHost = active.stage.parentElement ?? active.stage
  const changed =
    panelSessions.scope() !== 'alliance' ||
    !sameTemplateSurface(panelSurface, active.surface) ||
    panelHost !== nextHost ||
    allianceStage !== active.stage
  if (!changed) {
    syncPanelButtons()
    return
  }

  unmountSelectedPanel()
  panelSessions.select('alliance')
  panelSurface = active.surface
  panelHost = nextHost
  allianceStage = active.stage
  if (panelSessions.isOpen()) setOpen(true)
  else syncPanelButtons()
}

/** Whether the open world tree presents this template after search, filters, and collapse. */
export const isWorldTemplatePresented = (server: ServerConnection, templateId: string): boolean =>
  panelSessions.isWorldTreeVisible() && treeViewPresents(serverTemplateTreeKey(server, templateId))

export const onWorldTemplateTreeVisible = (listener: () => void): (() => void) => {
  worldTreeVisibleListeners.add(listener)
  return () => worldTreeVisibleListeners.delete(listener)
}

/** The panel hides while the template studio is open, and comes back if it was open before. */
let hiddenForStudio = false

const followTemplateStudio = (open: boolean): void => {
  if (open) {
    hiddenForStudio = panelOpen()
    if (hiddenForStudio) setOpen(false)
    return
  }
  if (hiddenForStudio && !panelOpen()) setOpen(true)
  hiddenForStudio = false
}

/** Install the rail, the panel it opens, and everything that redraws the panel's current view. */
export const installPanel = (): void => {
  void ensureLocalTags()
    .then(refreshView)
    .catch(() => showToast('Could not load local tags. Reload the page to try again.', 'error'))
  panelSessions.select('world')
  panelHost = document.body
  installTreeView({
    surface: () => panelSurface,
    rerender: rerenderTree,
    render: renderTree,
    addServer: () => showView('settings'),
  })
  void refreshStoredServers(refreshView)
  installServerConnectionRetry(refreshView)
  installRail({
    isOpen: (scope) => panelSessions.isOpen(scope),
    toggleWorld: () => togglePanelFor('world'),
    toggleAlliance: (active) => {
      selectAlliancePanelSurface(active)
      togglePanelFor('alliance')
    },
    insetAllianceDrawer: (active) => {
      if (!panelSessions.isOpen('alliance')) return
      const panel = active.stage.ownerDocument.getElementById(ALLIANCE_PANEL_ID)
      const measuredWidth = panel?.getBoundingClientRect().width ?? 0
      const width = measuredWidth > 0 ? measuredWidth : panelWidthForViewport(getState().panelWidth)
      allianceDrawerInset.apply(active.stage, width, GAP)
    },
  })
  onClaimEditorChange(closePanelForMobileDrawing)
  // The claims drawer follows the editor.
  onClaimEditorChange(rerenderTree)
  // Headcounts and region claims arrive over the socket; the Painters drawer has to follow them.
  onPresenceChange(() =>
    measureProfile('Presence drawer', () => {
      recordProfileCounter('Presence drawer notifications')
      refreshPresenceDrawer()
    }),
  )
  onViewChange(followViewFocus, 'Template tree focus')
  onTemplateStudioChange(followTemplateStudio)
  window.addEventListener('resize', () => {
    invalidateOverlayControlsEdge()
    closePanelForMobileDrawing()
    positionRail()
    positionChargeForecast()
    const panel = currentPanel()
    if (panel !== null) {
      const width = panelWidthForViewport(getState().panelWidth)
      panel.model = panelModel(width)
      if (allianceStage !== null) allianceDrawerInset.apply(allianceStage, width, GAP)
    }
    const active = activeAllianceSurface()
    if (active !== null) positionAllianceRail(active)
    redraw()
  })
  // Once, here, rather than each time a view is built: subscribing from inside a view added a
  // fresh listener on every switch back to it.
  let previousState = getState()
  onStateChange((next) => {
    const expansionOnly = onlyExpansionChanged(previousState, next)
    const serversChanged = previousState.servers !== next.servers
    previousState = next
    if (serversChanged && panelOpen()) void primeFromCache(rerenderTree)
    if (expansionOnly) redrawView()
    else refreshView()
  })
  onAllianceManifestChange(refreshView)
  onSettingsViewChange(refreshSettings)
  // A patch switched from the console must not leave an open settings view showing the old state.
  onWplacePatchChange(refreshSettings)
  // The same for any setting changed in the extension's toolbar popup or another tab.
  onStoredValueChange(refreshSettings)
  onOtherBuildChange(refreshSettings)
  onActiveAllianceSurfaceChange(selectAlliancePanelSurface)
  selectAlliancePanelSurface(activeAllianceSurface())
  onLocalChange(
    frameQueue(() => {
      if (currentView() === 'tree') refreshView()
    }),
  )
  onOfficialOverlaysChange(
    frameQueue(() => {
      if (currentView() === 'tree' && panelSurface.kind === 'world') refreshView()
    }),
  )
  // A new HQ snapshot and native canvas writes in one frame cost one rebuild between them.
  let pendingCanvasWrites = new Set<object>()
  let artboardPixelsChanged = false
  const refreshAllianceProgress = frameQueue(() => {
    const writes = pendingCanvasWrites
    const changed = artboardPixelsChanged
    pendingCanvasWrites = new Set()
    artboardPixelsChanged = false
    if (currentView() !== 'tree' || panelSurface.kind === 'world') return
    if (changed) {
      refreshView()
      return
    }
    if (writes.size === 0) return
    const active = activeAllianceSurface()
    if (active === null || !sameTemplateSurface(active.surface, panelSurface)) return
    if (canvasWritesTouchArtboard(active, writes)) refreshView()
  })
  onCanvasWrite((canvas) => {
    pendingCanvasWrites.add(canvas)
    refreshAllianceProgress()
  })
  const artboardPixelsChange = (): void => {
    artboardPixelsChanged = true
    refreshAllianceProgress()
  }
  onArtboardPixelsChange(artboardPixelsChange)
  onHeadquartersTilesChange(artboardPixelsChange)
  pixelAccounting.onChange(
    frameQueue(() => {
      if (currentView() !== 'tree') return
      // Sorted by progress, a tick can reorder rows, so only a rebuild is correct.
      const { field } = getState().sort
      if (field === 'progress' || field === 'mismatched') {
        refreshView()
        return
      }
      refreshTreeProgress()
    }),
  )
  onServerStatusChange(() => {
    if (currentView() === 'tree') refreshView()
  })
  onServerAlarmChange(() => {
    if (currentView() === 'tree') refreshView()
  })
  for (const ending of ['dragend', 'focusout'])
    document.addEventListener(ending, repayRefresh, true)
  document.addEventListener(
    'pointerdown',
    (event) => {
      const panel = document.getElementById(currentPanelId())
      if (panel !== null && event.composedPath().includes(panel)) {
        heldPanelPointers.add(event.pointerId)
      }
    },
    true,
  )
  for (const ending of ['pointerup', 'pointercancel'] as const) {
    document.addEventListener(
      ending,
      (event) => {
        heldPanelPointers.delete(event.pointerId)
        repayRefresh()
      },
      true,
    )
  }
  window.addEventListener('blur', () => {
    heldPanelPointers.clear()
    repayRefresh()
  })
  // Opening wplace's paint drawer changes what the appearance grid is showing without changing any
  // state of ours. Only that view: the tree is expensive to rebuild and a colour click while
  // painting would rebuild it every time.
  onPaintSelectionChange(() => {
    if (currentView() === 'appearance') refreshView()
  })
}
