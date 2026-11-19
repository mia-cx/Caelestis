import { TILE_SIZE } from '@caelestis/shared'
import { registerCaelestisUi } from '@caelestis/ui/elements'
import { installAlarmNotifications } from './alarms.js'
import { installAllianceServerSync } from './alliance-server-sync.js'
import { currentSurface, installAllianceSurfaceObserver } from './alliance-surface.js'
import { installClaims } from './claims.js'
import { installDebugApi, loadDebugSetting, warn } from './debug.js'
import { clearDraftPixels, reconcileDrafts, syncDraftCanvases } from './draft-pixels.js'
import { installAllianceOverlayLayer } from './gl/artboard-layer.js'
import { onMapThemeChange } from './gl/contrast-outline.js'
import { outlineLayer, overlayLayer } from './gl/layer.js'
import { installLayerStack } from './gl/layer-stack.js'
import { markerLayer } from './gl/markers.js'
import { pickCellLayer } from './gl/pick-cell-layer.js'
import { presenceLayer } from './gl/presence-layer.js'
import { installKeyboardShortcuts } from './keyboard-shortcuts.js'
import { getMap, installMapCapture, onMapAttached } from './map-handle.js'
import {
  installMapView,
  onMapFrame,
  onViewChange,
  redraw,
  requestMapFrame,
  screenProjection,
} from './map-view.js'
import { installPaintTargetGuard, syncPaintTargetMap } from './paint-target-guard.js'
import { installPaintPaletteProgress, refreshPaintPaletteFocus } from './palette-decoration.js'
import { installPresence, onPresenceChange } from './presence-client.js'
import { renderPresenceLabels } from './presence-labels.js'
import { observePresenceFrame } from './presence-local.js'
import { onSceneHoverChange } from './presence-scene.js'
import { installProfile, recordProfileAction, registerProfileContextSource } from './profile.js'
import { readProfileContext } from './profile-context.js'
import { installServerSyncCoordinator } from './server-sync-coordinator.js'
import { loadState, onStateChange } from './settings.js'
import { installShiftPaint } from './shift-paint.js'
import { installHeldKeyTracker } from './simulated-input.js'
import { installTelemetry } from './telemetry.js'
import { onLocalChange, onLocalPreviewChange } from './templates/catalog.js'
import { pixelAccounting } from './templates/mismatch.js'
import { installOfficialEvents, syncOfficialOverlays } from './templates/official-overlays.js'
import { installPersonalTemplates } from './templates/personal-sync.js'
import { installServerSync } from './templates/server-sync.js'
import { syncStudioFrame } from './templates/studio-frame.js'
import { installTilePixelCapture } from './tile-capture-scope.js'
import { install as installTileCapture } from './tile-transform.js'
import { installChargeForecast } from './ui/charge-forecast.js'
import { renderOverlayControls } from './ui/overlay-menu.js'
import { installPanel } from './ui/panel.js'
import { openInviteFromLocation } from './ui/settings-controller.js'
import { installUserscriptUpdateCheck } from './userscript-update.js'
import { loadAccount, observeAccountReads } from './wplace-account.js'
import { installWplaceCursors } from './wplace-cursors.js'
import { installWplaceFont } from './wplace-font.js'
import { installWplaceMessages } from './wplace-modules.js'
import { isPaintOpen, onPaintSelectionChange, watchPaintSelection } from './wplace-paint.js'
import { applyWplacePatches } from './wplace-patches.js'
import { installColourPicker } from './wplace-picker.js'
import { installWplaceSettings } from './wplace-settings.js'
import { installWplaceStateCapture } from './wplace-state.js'
import { onWplacePatchChange } from './wplace-switches.js'
import { installServiceWorkerTap } from './wplace-tile-refresh.js'

/** Run one independent piece of start-up without letting its failure cancel the rest. */
const step = (what: string, run: () => void): void => {
  try {
    run()
  } catch (error) {
    warn(`${what} failed to start`, String(error))
  }
}

/** Install the userscript in the world it was started in, with the manager's storage at hand. */
export const startUserscript = (): void => {
  installPageHooks()
  installUserscriptFeatures()
}

/** The userscript's features, once its stored values are readable. */
export const installUserscriptFeatures = (): void => {
  installFeatures()
  // The extension's stores update it themselves.
  step('userscript update check', installUserscriptUpdateCheck)
}

/**
 * Everything that must be in place before Wplace's own modules evaluate: the traps on its fetches,
 * state and map. Nothing here needs stored values; the debug flag read here is read again once they
 * load. So the extension, whose stored values arrive asynchronously, runs this synchronously at
 * document start.
 */
export const installPageHooks = (): void => {
  step('debug API', installDebugApi)
  step('shared UI', registerCaelestisUi)
  step('FalseType font', installWplaceFont)
  step('Caelestis cursors', installWplaceCursors)
  registerProfileContextSource(readProfileContext)
  // These traps must be armed before Wplace's modules evaluate or MapLibre constructs its Map.
  step('service-worker tile refresh tap', () => installServiceWorkerTap())
  step('wplace state capture', installWplaceStateCapture)
  step('Wplace messages', () => void installWplaceMessages())
  step('map capture', installMapCapture)
  step('tile capture', installTileCapture)
  // After the request observer, so its startup read of the alliance is observed too.
  step('alliance surface observer', installAllianceSurfaceObserver)
  step('account reads', observeAccountReads)
}

/**
 * Everything that reads stored values, which runs once they are loaded. Settings load first;
 * frame followers run in registration order.
 */
export const installFeatures = (): void => {
  step('debug logging', loadDebugSetting)
  step('performance profile', installProfile)
  step('Wplace settings', installWplaceSettings)
  step('settings', () => void loadState())
  // Templates outlive a page load, which is what makes navigating to one survivable at all.
  step('local templates', () => void installPersonalTemplates())
  // Wplace's own event overlays, such as the Seven Seals, listed read-only under Events.
  step('official events', () => void installOfficialEvents())
  // Server templates do not: they are re-fetched, because the server is where they live and a copy
  // kept here would outlive its deletion. Chunks are immutable and cached, so this is cheap.
  step('server templates', installServerSync)
  step('alliance server templates', installAllianceServerSync)
  step('server telemetry', installTelemetry)
  step('server sync coordinator', installServerSyncCoordinator)
  step('alarm notifications', installAlarmNotifications)
  step('wplace account', () => void loadAccount())
  step('charge forecast', installChargeForecast)
  step('paint watcher', installPaintWatcher)
  step('paint palette progress', installPaintPaletteProgress)
  onMapFrame(refreshPaintPaletteFocus, 'Paint palette focus')
  // Middle-click picking, answered from the template when the template is what you can see.
  step('held keys', installHeldKeyTracker)
  step('paint target guard', installPaintTargetGuard)
  step('colour picker', installColourPicker)
  step('shift paint', installShiftPaint)
  step('keyboard shortcuts', () => installKeyboardShortcuts())
  // A completed scan changes marker buffers and progress only. Progress has its own DOM listeners;
  // rerunning every screen-space overlay control here duplicates the MapLibre frame requested next.
  step('mismatch repaint', () => pixelAccounting.onChange(requestMapFrame))
  // Wplace adds a layer per tile being painted; its canvas is where unsubmitted pixels are drawn.
  step('draft canvases', () => onMapFrame(syncDraftCanvases, 'Name draft canvases'))
  // Drafting Transparent writes nothing a canvas hook can see, so the only place it shows up is
  // wplace's crosshairs. Throttled inside; with nothing drafted there is nothing to read.
  step('drafted pixels', () => onMapFrame(reconcileDrafts, 'Reconcile drafted pixels'))
  step('presence', installPresenceFeatures)
  step('tile pixel capture', installTilePixelCapture)
  step('overlay layer', attachOverlayLayer)
  step('alliance overlay layer', installAllianceOverlayLayer)
  onMapFrame((frame) => {
    if (currentSurface().kind === 'world') renderOverlayControls(frame.canvas)
  }, 'Overlay controls')
  step('map view', installMapView)
  onLocalChange(redraw)
  onLocalPreviewChange(redraw)
  onStateChange(redraw)
  onMapThemeChange(redraw)
  step('panel', () => afterDocumentLoads(installPanel))
  // Invite links ride in the fragment. Consume one only once the panel exists — its toast is how
  // the outcome is reported — and again whenever the fragment changes in an open tab.
  step('invite links', () => {
    window.addEventListener('hashchange', () => void openInviteFromLocation())
    afterDocumentLoads(() => void openInviteFromLocation())
  })
  try {
    console.info(`[caelestis] loaded — tile size ${TILE_SIZE}`)
  } catch {
    // A replaced console is not part of the render path.
  }
}

const installPaintWatcher = (): void => {
  watchPaintSelection()
  // The selected-colour marker lives in MapLibre's custom layer. Returning from Eraser to Pencil
  // changes the selected swatch without moving the map, so repainting only the retained
  // screen-space frame leaves that marker stale until some unrelated map animation happens.
  onPaintSelectionChange(() => {
    recordProfileAction(isPaintOpen() ? 'paint selection changed' : 'paint drawer closed')
    if (!isPaintOpen()) clearDraftPixels()
    redraw()
  })
}

/** Where this tab is looking and drafting, for the other painters; and their tags for us. */
const installPresenceFeatures = (): void => {
  installPresence()
  installClaims()
  // MapLibre coalesces message bursts into one frame, which also refreshes the screen controls.
  onPresenceChange(requestMapFrame)
  onSceneHoverChange(requestMapFrame)
  // The socket is throttled inside, so feeding it every frame costs a rect comparison.
  onMapFrame(observePresenceFrame, 'Presence viewport')
  onViewChange(syncStudioFrame, 'Template studio handles')
  onMapFrame((frame) => {
    if (currentSurface().kind === 'world') renderPresenceLabels(frame, screenProjection())
  }, 'Presence labels')
}

/** Keep our GL layers, and the features bound to the map, on whichever map Wplace shows. */
const attachOverlayLayer = (): void => {
  installLayerStack({
    outline: outlineLayer,
    overlay: overlayLayer,
    markers: markerLayer,
    presence: presenceLayer,
    pickCell: pickCellLayer,
  })
  onMapAttached((map) => {
    syncPaintTargetMap(map)
    syncOfficialOverlays(map)
    applyWplacePatches(map)
  })
  onWplacePatchChange(() => applyWplacePatches(getMap()))
}

/** Runs now, or at `DOMContentLoaded` in registration order while the page is still loading. */
const afterDocumentLoads = (run: () => void): void => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}
