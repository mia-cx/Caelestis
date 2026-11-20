import { warn } from './debug.js'
import { installPaintReports, replayRecentPaints } from './paint-reports.js'
import { installServerAlarms } from './server-alarms.js'
import {
  type ConnectedServer,
  connectedServers,
  isConnected,
  isCurrentServerConnection,
  onServerRemoved,
} from './server-connections.js'
import { type ManifestCoverage, manifestCoverage, onManifestChange } from './server-manifests.js'
import { installServerStatus } from './server-status.js'
import { requestServerSync } from './server-sync-coordinator.js'
import { getState, onStateChange, type ServerConnection } from './settings.js'
import { onFetchedTile } from './tile-attribution.js'
import {
  observeTile,
  pruneTileOffers,
  reconcileTileOffers,
  replayTileOffers,
  wantsObservedTile,
} from './tile-offer-outbox.js'

/**
 * What this client reports to and reads from connected servers about the canvas: tile offers,
 * paint reports, template status and alarms. This module keeps them in step with each server's
 * manifest coverage; each lives in its own module.
 */

/** The coverage each server's telemetry last reconciled against, and through which connection. */
const reconciledCoverage = new Map<
  string,
  { readonly server: ConnectedServer; readonly coverage: ManifestCoverage }
>()

onServerRemoved((serverUrl) => {
  reconciledCoverage.delete(serverUrl)
})

/** Reconcile offers, receipts and reads with a newly admitted world manifest's coverage. */
const reconcileCoverage = (server: ServerConnection): void => {
  if (!isConnected(server) || !isCurrentServerConnection(server)) return
  const coverage = manifestCoverage(server)
  if (coverage === null) return
  const held = reconciledCoverage.get(server.url)
  const previous = held !== undefined && isCurrentServerConnection(held.server) ? held : undefined
  const seasonChanged = held !== undefined && held.server.season !== server.season
  // The store keeps the coverage object while a revisioned manifest covers the same tiles.
  const coverageChanged = previous?.coverage !== coverage
  reconciledCoverage.set(server.url, { server, coverage })
  reconcileTileOffers(server, coverageChanged)
  if (coverageChanged) {
    // The coordinator already includes status in the initial connection sweep. Only a later
    // manifest change invalidates an established status surface; alarms cannot run until the first
    // coverage snapshot exists, so they still need that first targeted read.
    if (previous !== undefined) requestServerSync('manifest-applied', 'telemetry-status', server)
    requestServerSync('manifest-applied', 'telemetry-alarms', server)
  }
  replayTileOffers(server, !seasonChanged)
  replayRecentPaints()
}

let installed = false

export const installTelemetry = (): void => {
  if (installed) return
  installed = true
  onManifestChange((server, surface, change) => {
    if (surface.kind === 'world' && change.status === 'admitted') reconcileCoverage(server)
  })
  onFetchedTile((tile, bytes, observedAt) => {
    void observeTile(tile, bytes, observedAt).catch((error: unknown) =>
      warn('telemetry failed', String(error)),
    )
  }, wantsObservedTile)
  installPaintReports()
  onStateChange(() => {
    pruneTileOffers()
    const shareTiles = getState().shareTiles
    for (const server of connectedServers()) replayTileOffers(server, shareTiles)
    replayRecentPaints()
  })
  installServerStatus()
  installServerAlarms()
}
