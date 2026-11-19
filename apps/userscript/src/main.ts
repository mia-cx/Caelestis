import { TILE_SIZE } from '@caelestis/shared'
import { registerCaelestisUi } from '@caelestis/ui/elements'
import { installAlarmNotifications } from './alarms.js'
import { installAllianceServerSync } from './alliance-server-sync.js'
import { activeAllianceSurface, installAllianceSurfaceObserver } from './alliance-surface.js'
import { onClaimEditorChange, syncClaimEditorFrame } from './claim-editor.js'
import { installClaimRouting } from './claim-routing.js'
import { installDebugApi, loadDebugSetting, warn } from './debug.js'
import { installAllianceOverlayLayer, repaintAllianceOverlayLayer } from './gl/artboard-layer.js'
import { onMapThemeChange } from './gl/contrast-outline.js'
import { installOverlayLayer } from './gl/layer.js'
import { keepMarkersAboveDrafts } from './gl/markers.js'
import { installPickCellLayer } from './gl/pick-cell-layer.js'
import { installPresenceLayer, repaintPresence } from './gl/presence-layer.js'
import { installKeyboardShortcuts } from './keyboard-shortcuts.js'
import { getMap, installMapCapture, type PatchableMap, releaseMapCapture } from './map-handle.js'
import {
  installMapView,
  notifyArtboardViewChange,
  onMapFrame,
  onRedraw,
  onViewChange,
  redraw,
  repaint,
  requestMapFrame,
  screenProjection,
  viewportCentre,
} from './map-view.js'
import { installPaintTargetGuard, syncPaintTargetMap } from './paint-target-guard.js'
import { installPaintPaletteProgress, refreshPaintPaletteFocus } from './palette-decoration.js'
import { installPresence, onPresenceChange } from './presence-client.js'
import { renderPresenceLabels } from './presence-labels.js'
import { observePresenceFrame } from './presence-local.js'
import { onSceneHoverChange } from './presence-scene.js'
import { installProfile, recordProfileAction, registerProfileContextSource } from './profile.js'
import { readProfileContext } from './profile-context.js'
import { installQuickClaims, onQuickClaimPreviewChange } from './quick-claims.js'
import { installServerSyncCoordinator } from './server-sync-coordinator.js'
import { loadState, onStateChange } from './settings.js'
import { installShiftPaint } from './shift-paint.js'
import { installHeldKeyTracker } from './simulated-input.js'
import { installTelemetry } from './telemetry.js'
import { onLocalChange, onLocalPreviewChange } from './templates/local-store.js'
import { pixelAccounting } from './templates/mismatch.js'
import { installOfficialEvents, syncOfficialOverlays } from './templates/official-overlays.js'
import { installPersonalTemplates } from './templates/personal-sync.js'
import { installServerSync } from './templates/server-sync.js'
import { syncStudioFrame } from './templates/studio-frame.js'
import {
  captureTilePixels,
  clearDraftPixels,
  install as installTileCapture,
  reconcileDrafts,
} from './tile-transform.js'
import { installChargeForecast } from './ui/charge-forecast.js'
import { renderOverlayControls } from './ui/overlay-menu.js'
import { installPanel, openInviteFromLocation, refreshTemplateTreeFocus } from './ui/panel.js'
import { installClaimToolHost } from './ui/presence-actions.js'
import { installUserscriptUpdateCheck } from './userscript-update.js'
import { loadAccount } from './wplace-account.js'
import { installWplaceCursors } from './wplace-cursors.js'
import { installWplaceFont } from './wplace-font.js'
import { installWplaceMessages } from './wplace-modules.js'
import { isPaintOpen, onPaintSelectionChange, watchPaintSelection } from './wplace-paint.js'
import { applyWplacePatches } from './wplace-patches.js'
import { installColourPicker } from './wplace-picker.js'
import { installWplaceSettings } from './wplace-settings.js'
import { installWplaceStateCapture } from './wplace-state.js'
import { onWplacePatchChange } from './wplace-switches.js'
import { installServiceWorkerTap, watchCaptureScope } from './wplace-tile-refresh.js'

/** Run one independent piece of start-up without letting its failure cancel the rest. */
const step = (what: string, run: () => void): void => {
  try {
    run()
  } catch (error) {
    warn('install', `${what} failed to start`, String(error))
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
  step('alliance surface observer', installAllianceSurfaceObserver)
  step('tile capture', installTileCapture)
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
  onViewChange(refreshTreeFocus, 'Template tree focus')
  // Middle-click picking, answered from the template when the template is what you can see.
  step('held keys', installHeldKeyTracker)
  step('paint target guard', installPaintTargetGuard)
  step('colour picker', installColourPicker)
  step('shift paint', installShiftPaint)
  step('keyboard shortcuts', () => installKeyboardShortcuts())
  // A completed scan changes marker buffers and progress only. Progress has its own DOM listeners;
  // rerunning every screen-space overlay control here duplicates the MapLibre frame requested next.
  step('mismatch repaint', () => pixelAccounting.onChange(requestMapFrame))
  // wplace add a layer per tile being painted, above anything of ours added earlier, so a placed
  // pixel would otherwise cover the marker it just cleared.
  step('marker order', () => onMapFrame(keepMarkersAboveDrafts, 'Keep marker layer above drafts'))
  // Drafting Transparent writes nothing a canvas hook can see, so the only place it shows up is
  // wplace's crosshairs. Throttled inside; with nothing drafted there is nothing to read.
  step('drafted pixels', () => onMapFrame(reconcileDrafts, 'Reconcile drafted pixels'))
  step('presence', installPresenceFeatures)
  step('tile pixel capture', installTilePixelCapture)
  step('overlay layer', attachOverlayLayer)
  step('alliance overlay layer', () => installAllianceOverlayLayer(notifyArtboardViewChange))
  onRedraw(repaintAllianceOverlayLayer)
  onMapFrame((frame) => {
    if (activeAllianceSurface() === null) renderOverlayControls(repaint, frame.canvas)
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

let lastTreeFocusCentre: { readonly x: number; readonly y: number } | null | undefined

/** The panel's focused row follows the view; on the world map, only when its centre moves. */
const refreshTreeFocus = (): void => {
  if (activeAllianceSurface() === null) {
    const centre = viewportCentre()
    if (
      lastTreeFocusCentre !== undefined &&
      (centre === null
        ? lastTreeFocusCentre === null
        : lastTreeFocusCentre?.x === centre.x && lastTreeFocusCentre.y === centre.y)
    )
      return
    lastTreeFocusCentre = centre
  }
  refreshTemplateTreeFocus()
}

/** Where this tab is looking and drafting, for the other painters; and their tags for us. */
const installPresenceFeatures = (): void => {
  installPresence()
  installClaimRouting()
  // MapLibre coalesces message bursts into one frame, which also refreshes the screen controls.
  onPresenceChange(repaintPresence)
  onClaimEditorChange(repaintPresence)
  onSceneHoverChange(repaintPresence)
  onQuickClaimPreviewChange(repaintPresence)
  installQuickClaims()
  installClaimToolHost()
  // The socket is throttled inside, so feeding it every frame costs a rect comparison.
  onMapFrame(observePresenceFrame, 'Presence viewport')
  onMapFrame(syncClaimEditorFrame, 'Claim editor overlay')
  onViewChange(syncStudioFrame, 'Template studio handles')
  onMapFrame((frame) => {
    if (activeAllianceSurface() === null) renderPresenceLabels(frame, screenProjection())
  }, 'Presence labels')
}

/**
 * Start capturing before the first frame, not on it.
 *
 * A tile can only be caught as it is decoded, and the tiles filling the viewport on a page load
 * are decoded during the load — before any layer of ours has drawn. Deciding whether to capture at
 * draw time meant missing every one of them, and each then waited on wplace re-fetching it, which
 * is why a tile panned to answered in under a second while the ones already on screen took ten.
 */
const installTilePixelCapture = (): void => {
  // The pipette fallback reads the exact pixel-art tile, so Paint itself is a pixel consumer even
  // when mismatch markers are off. Starting at drawer-open gives visible tiles time to populate
  // before the one-shot picker click; a miss is also chased on demand by `placedIndexAt`.
  const interest = (tile: { readonly x: number; readonly y: number }): boolean =>
    isPaintOpen() || pixelAccounting.wantsTilePixels(tile)
  const captureScope = watchCaptureScope()
  const sync = (): void => {
    // The scope holds a tile exactly when `wantsTilePixels()` would answer yes, and unlike it,
    // costs nothing on a frame where nothing changed.
    const scope = pixelAccounting.captureScopeTiles()
    captureTilePixels(scope.size > 0 || isPaintOpen(), interest)
    // Pixels kept while capture was off may be stale, and tiles are no longer re-downloaded on a
    // timer to correct them. When capture starts caring about a tile, re-read it.
    captureScope(isPaintOpen(), scope)
  }
  sync()
  onStateChange(sync)
  onLocalChange(sync)
  // Hidden-template progress widens the scope without a frame, and its idle scan can run first.
  pixelAccounting.onCaptureScopeChange(sync)
  onPaintSelectionChange(sync)
  // And on every frame that carries tiles. The four above are the events that *should* cover it,
  // and between them they missed the only one that mattered: at start-up nothing is restored yet,
  // so the first call answers "nothing wants this" and the restore that follows does not
  // necessarily announce itself. Asking again per frame costs a comparison and cannot be wrong.
  onMapFrame(sync, 'Tile pixel capture state')
}

/** Keep the GL layer attached across delayed map creation, style reloads, and SPA map replacement. */
const attachOverlayLayer = (): void => {
  const attach = (): void => {
    const map = getMap()
    if (map !== null) {
      try {
        if (!map.getCanvas().isConnected) releaseMapCapture()
      } catch {
        // A torn-down MapLibre map can throw from its own accessors.
        releaseMapCapture()
      }
    }
    if (getMap() === null) installMapCapture()
    installOverlayLayer()
    installPresenceLayer()
    installPickCellLayer()
    syncPaintTargetMap(getMap())
    syncOfficialOverlays(getMap())
    applyWplacePatches(getMap() as PatchableMap | null)
  }
  onWplacePatchChange(() => applyWplacePatches(getMap() as PatchableMap | null))
  attach()
  setInterval(attach, 1_000)
}

/** Runs now, or at `DOMContentLoaded` in registration order while the page is still loading. */
const afterDocumentLoads = (run: () => void): void => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}
