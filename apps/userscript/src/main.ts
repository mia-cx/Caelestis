import { TILE_SIZE } from '@caelestis/shared'
import { registerCaelestisUi } from '@caelestis/ui/elements'
import { installAlarmNotifications } from './alarms.js'
import { installAllianceServerSync } from './alliance-server-sync.js'
import { installAllianceSurfaceObserver } from './alliance-surface.js'
import { installTransfers } from './application/transfer.js'
import { installClaims } from './claims.js'
import { installDebugApi, loadDebugSetting, warn } from './debug.js'
import { installDraftPixels } from './draft-pixels.js'
import { installEventTeam } from './event-team.js'
import { installAllianceOverlayLayer } from './gl/artboard-layer.js'
import { installOverlayLayers } from './gl/overlay-layers.js'
import { installKeyboardShortcuts } from './keyboard-shortcuts.js'
import { installMapCapture } from './map-handle.js'
import { installMapView } from './map-view.js'
import { install as installTileCapture } from './page-taps.js'
import { installPaintTargetGuard } from './paint-target-guard.js'
import { installPaintPaletteProgress } from './palette-decoration.js'
import { installPresenceFeatures } from './presence.js'
import { installProfile, registerProfileContextSource } from './profile.js'
import { readProfileContext } from './profile-context.js'
import { installServerConnections } from './server-connections.js'
import { installServerSyncCoordinator } from './server-sync-coordinator.js'
import { loadState } from './settings.js'
import { installShiftPaint } from './shift-paint.js'
import { installTelemetry } from './telemetry.js'
import { installMismatchAccounting } from './templates/mismatch.js'
import { installOfficialEvents } from './templates/official-overlays.js'
import { installPersonalTemplates } from './templates/personal-sync.js'
import { installServerSync } from './templates/server-sync.js'
import { installStudioFrame } from './templates/studio-frame.js'
import { installTerritoryRefusals } from './territory-refusals.js'
import { installTilePixelCapture } from './tile-capture-scope.js'
import { installChargeForecast } from './ui/charge-forecast.js'
import { installOverlayControls, showAllianceOverlayControls } from './ui/overlay-menu.js'
import { installPanel } from './ui/panel.js'
import { openInviteFromLocation } from './ui/settings-controller.js'
import { installTreeCopy } from './ui/tree-copy.js'
import { installUserscriptUpdateCheck } from './userscript-update.js'
import { loadAccount, observeAccountReads } from './wplace-account.js'
import { installChargeSpending } from './wplace-charges.js'
import { installWplaceCursors } from './wplace-cursors.js'
import { installWplaceFont } from './wplace-font.js'
import { installWplaceMessages } from './wplace-modules.js'
import { watchPaintSelection } from './wplace-paint.js'
import { installWplacePatches } from './wplace-patches.js'
import { installColourPicker } from './wplace-picker.js'
import { installWplaceSettings } from './wplace-settings.js'
import { installWplaceStateCapture } from './wplace-state.js'
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
  step('event team', installEventTeam)
}

/**
 * Everything that reads stored values, which runs once they are loaded. Settings load first. Frame
 * followers run in the order their features install, and the map view goes after all of them.
 */
export const installFeatures = (): void => {
  step('debug logging', loadDebugSetting)
  step('performance profile', installProfile)
  step('Wplace settings', installWplaceSettings)
  step('settings', () => void loadState())
  step('server connections', installServerConnections)
  step('server transfers', installTransfers)
  step('mismatch accounting', installMismatchAccounting)
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
  step('charge spending', installChargeSpending)
  step('charge forecast', installChargeForecast)
  step('paint watcher', watchPaintSelection)
  step('draft pixels', installDraftPixels)
  step('paint palette progress', installPaintPaletteProgress)
  step('paint target guard', installPaintTargetGuard)
  step('territory refusals', () => void installTerritoryRefusals())
  // Middle-click picking, answered from the template when the template is what you can see.
  step('colour picker', installColourPicker)
  step('shift paint', installShiftPaint)
  step('keyboard shortcuts', () => installKeyboardShortcuts())
  step('presence', installPresenceFeatures)
  step('claims', installClaims)
  step('template studio handles', installStudioFrame)
  step('tile pixel capture', installTilePixelCapture)
  step('overlay layers', installOverlayLayers)
  step('Wplace patches', installWplacePatches)
  step('alliance overlay layer', () => installAllianceOverlayLayer(showAllianceOverlayControls))
  step('overlay controls', installOverlayControls)
  step('map view', installMapView)
  step('tree copy', installTreeCopy)
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

/** Runs now, or at `DOMContentLoaded` in registration order while the page is still loading. */
const afterDocumentLoads = (run: () => void): void => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}
