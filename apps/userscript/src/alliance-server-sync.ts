import {
  type ReconciliationReason,
  type SyncTransport,
  sameTemplateSurface,
  type TemplateSurface,
  templateSurfaceKey,
} from '@caelestis/shared'
import { activeAllianceSurface, onActiveAllianceSurfaceChange } from './alliance-surface.js'
import { registerDebugEntry } from './console-api.js'
import { count } from './debug.js'
import {
  type ConnectedServer,
  connectedServerAt,
  isCurrentServerConnection,
} from './server-connections.js'
import {
  applyLiveManifest,
  forgetManifestSurface,
  onManifestChange,
  readManifest,
} from './server-manifests.js'
import {
  registerServerSyncResource,
  requestServerSync,
  type ServerSyncResult,
} from './server-sync-coordinator.js'
import { getState, type ServerConnection } from './settings.js'
import { serverTemplatesSettled } from './templates/server-sync.js'
import { forgetServerSurfaceTemplates } from './templates/template-copies.js'

/**
 * Which alliance surface's manifests are read: only the one whose Wplace editor is active. Leaving
 * a surface forgets its manifests and takes its templates off the canvas before the next one is
 * read; the manifest store does the reading and admission itself.
 */

const ALLIANCE_MANIFEST_RESOURCE = 'alliance-manifest'

let installed = false
let generation = 0
let controller: AbortController | null = null
let selected: TemplateSurface | null = null
let readyGeneration = -1
let transition = Promise.resolve()

/** Observe every alliance manifest admitted, refused or forgotten. */
export const onAllianceManifestChange = (listener: () => void): (() => void) =>
  onManifestChange((_server, surface) => {
    if (surface.kind !== 'world') listener()
  })

/** Refresh an edited alliance surface and report whether its manifest was admitted. */
export const refreshAllianceManifest = async (
  server: ServerConnection,
  surface: TemplateSurface,
): Promise<ServerSyncResult> => {
  const ownGeneration = generation
  const signal = controller?.signal
  if (
    signal === undefined ||
    readyGeneration !== ownGeneration ||
    selected === null ||
    !sameTemplateSurface(selected, surface)
  )
    return { status: 'skipped' }
  const current = connectedServerAt(server.url)
  if (current === undefined) return { status: 'skipped' }
  return await readServer(current, surface, ownGeneration, signal, 'manual', 'compatibility-poll')
}

const currentSurface = (surface: TemplateSurface, ownGeneration: number): boolean => {
  const active = activeAllianceSurface()
  return (
    generation === ownGeneration && active !== null && sameTemplateSurface(active.surface, surface)
  )
}

const readServer = async (
  server: ConnectedServer,
  surface: TemplateSurface,
  ownGeneration: number,
  signal: AbortSignal,
  reason: ReconciliationReason,
  transport: SyncTransport,
): Promise<ServerSyncResult> => {
  count('alliance-sync:server considered')
  if (!isCurrentServerConnection(server)) {
    count('alliance-sync:server not connected')
    return { status: 'skipped' }
  }
  if (!currentSurface(surface, ownGeneration)) {
    count('alliance-sync:surface superseded')
    return { status: 'skipped' }
  }
  count('alliance-sync:manifest requested')
  const contents = await readManifest(server, { surface, signal, reason, transport })
  if (contents === null || !currentSurface(surface, ownGeneration)) {
    count('alliance-sync:manifest failed')
    // A failed alliance read keeps the last admitted overlay, like the world manifest poll.
    return { status: 'failed' }
  }
  await serverTemplatesSettled(server, surface)
  return contents.revision === undefined
    ? { status: 'unchanged' }
    : { status: 'unchanged', revision: contents.revision }
}

const retire = async (surface: TemplateSurface): Promise<void> => {
  await Promise.all(
    getState().servers.map(
      async (server) => await forgetServerSurfaceTemplates(server.url, surface),
    ),
  )
}

const selectActiveSurface = (): void => {
  const next = activeAllianceSurface()?.surface ?? null
  if (
    selected === next ||
    (selected !== null && next !== null && sameTemplateSurface(selected, next))
  )
    return
  const previous = selected
  selected = next
  generation++
  readyGeneration = -1
  const ownGeneration = generation
  controller?.abort()
  controller = next === null ? null : new AbortController()
  // At once, so no read still in flight for the old surface can be admitted after it.
  if (previous !== null) forgetManifestSurface(previous)
  transition = transition
    .catch(() => undefined)
    .then(async () => {
      if (previous !== null) await retire(previous)
      if (generation !== ownGeneration) return
      readyGeneration = ownGeneration
      requestServerSync('state-change', ALLIANCE_MANIFEST_RESOURCE)
    })
  void transition.catch(() => undefined)
}

/** Poll exact alliance surface manifests only while that Wplace editor is active. */
export const installAllianceServerSync = (): void => {
  if (installed) return
  installed = true
  /** The active Wplace artboard and exact backend manifest scope selected for it. */
  registerDebugEntry('allianceSurface', () => ({
    active: activeAllianceSurface()?.surface ?? null,
    manifest: selectedAllianceManifestScope(),
    servers: getState().servers.map((server) => ({
      url: server.url,
      status: server.status,
      identified: server.info !== null,
      season: server.season,
    })),
  }))
  onActiveAllianceSurfaceChange(selectActiveSurface)
  registerServerSyncResource({
    id: ALLIANCE_MANIFEST_RESOURCE,
    live: true,
    reconcileOnManifestEvent: true,
    scope: () =>
      selected !== null && readyGeneration === generation ? templateSurfaceKey(selected) : null,
    refresh: async (server, reason, transport) => {
      const surface = selected
      const signal = controller?.signal
      if (surface === null || signal === undefined || readyGeneration !== generation)
        return { status: 'skipped' }
      return readServer(server, surface, generation, signal, reason, transport)
    },
    applyLiveEvent: async (server, event) => {
      const surface = selected
      const ownGeneration = generation
      if (
        surface === null ||
        readyGeneration !== ownGeneration ||
        event.type !== 'manifest-snapshot' ||
        event.scope !== templateSurfaceKey(surface) ||
        !currentSurface(surface, ownGeneration) ||
        applyLiveManifest(server, surface, event.manifest) === null
      )
        return false
      await serverTemplatesSettled(server, surface)
      return currentSurface(surface, ownGeneration) && isCurrentServerConnection(server)
    },
  })
  selectActiveSurface()
}

/** Stable diagnostic key for the currently selected alliance manifest scope. */
const selectedAllianceManifestScope = (): string | null =>
  selected === null ? null : templateSurfaceKey(selected)
