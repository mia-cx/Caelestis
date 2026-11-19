import {
  parseTileKey,
  type ReconciliationReason,
  type StatusDelta,
  type SyncTransport,
  type TemplateStatus,
} from '@caelestis/shared'
import { notifyListeners } from './listeners.js'
import {
  type ConnectedServer,
  isCurrentServerConnection,
  onServerRemoved,
  serverConnectionIdentity,
} from './server-connections.js'
import type { ServerTemplate } from './server-manifest.js'
import { invalidateServerMismatches, invalidateServerMismatchTiles } from './server-mismatch.js'
import { coalesceServerRead } from './server-read-coalescer.js'
import { backgroundRequest } from './server-request.js'
import {
  applyServerSyncDelta,
  applyServerSyncSnapshot,
  registerServerSyncResource,
  type ServerSyncResult,
  serverSyncRevision,
  WORLD_SCOPE,
} from './server-sync-coordinator.js'
import type { ServerConnection } from './settings.js'
import { type StatusSnapshot, statusDeltaFrom, statusSnapshotFrom } from './telemetry-wire.js'
import type { TemplateColourProgress, TemplateProgress } from './templates/progress-types.js'

/**
 * Each server's per-template progress as this client last read it: a full read from a poll or a
 * live snapshot, advanced by the ordered deltas that offers, uploads and the live socket carry.
 */

interface ServerStatuses {
  /** The connection the values were read through; a reconnect starts from a fresh snapshot. */
  server: ServerConnection
  readonly values: Map<string, TemplateStatus>
}

const statuses = new Map<string, ServerStatuses>()
const listeners = new Set<() => void>()

onServerRemoved((serverUrl) => {
  statuses.delete(serverUrl)
})

const sameStatus = (left: TemplateStatus | undefined, right: TemplateStatus): boolean =>
  left !== undefined &&
  left.templateId === right.templateId &&
  left.correct === right.correct &&
  left.wrong === right.wrong &&
  left.blank === right.blank &&
  left.total === right.total &&
  left.observedAt === right.observedAt &&
  (left.colours === undefined
    ? right.colours === undefined
    : right.colours !== undefined &&
      left.colours.length === right.colours.length &&
      left.colours.every((colour, index) => {
        const other = right.colours?.[index]
        return (
          other !== undefined &&
          colour.index === other.index &&
          colour.correct === other.correct &&
          colour.wrong === other.wrong &&
          colour.blank === other.blank &&
          colour.total === other.total
        )
      }))

const notify = (): void => {
  notifyListeners(listeners, 'status listener failed')
}

export const onServerStatusChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The status this connection last read for a template whose pixel total it still matches. */
const statusFor = (
  server: ServerConnection,
  template: Pick<ServerTemplate, 'id' | 'totalPixels'>,
): TemplateStatus | null => {
  const held = statuses.get(server.url)
  const status =
    held !== undefined && isCurrentServerConnection(held.server)
      ? held.values.get(template.id)
      : undefined
  return status === undefined || status.total !== (template.totalPixels ?? 0) ? null : status
}

export const serverProgressFor = (
  server: ServerConnection,
  template: Pick<ServerTemplate, 'id' | 'totalPixels'>,
): TemplateProgress | null => {
  const status = statusFor(server, template)
  return status === null
    ? null
    : {
        completed: status.correct,
        mismatched: status.wrong,
        unpainted: status.blank,
        known: status.correct + status.wrong + status.blank,
        total: status.total,
      }
}

export const serverColourProgressFor = (
  server: ServerConnection,
  template: Pick<ServerTemplate, 'id' | 'totalPixels'>,
): readonly TemplateColourProgress[] | null =>
  statusFor(server, template)?.colours?.map((colour) => ({
    index: colour.index,
    completed: colour.correct,
    mismatched: colour.wrong,
    unpainted: colour.blank,
    known: colour.correct + colour.wrong + colour.blank,
    total: colour.total,
  })) ?? null

/**
 * Apply one ordered delta from a mutation response or the live socket. Masks of the tiles it names,
 * or every mask when it says so, are stale afterwards.
 */
export const applyStatusDelta = (
  server: ConnectedServer,
  delta: StatusDelta,
): ReturnType<typeof applyServerSyncDelta> =>
  applyServerSyncDelta(
    server,
    WORLD_SCOPE,
    'telemetry-status',
    String(delta.baseRevision),
    String(delta.revision),
    () => {
      let held = statuses.get(server.url)
      if (held === undefined) {
        held = { server, values: new Map() }
        statuses.set(server.url, held)
      }
      held.server = server
      let changed = false
      for (const status of delta.templates) {
        if (sameStatus(held.values.get(status.templateId), status)) continue
        held.values.set(status.templateId, status)
        changed = true
      }
      for (const templateId of delta.removedTemplateIds)
        changed = held.values.delete(templateId) || changed
      if (changed) notify()
      if (delta.invalidateAllTiles === true) invalidateServerMismatches(server.url)
      else
        invalidateServerMismatchTiles(
          server.url,
          (delta.invalidatedTiles ?? []).flatMap((key) => parseTileKey(key) ?? []),
        )
    },
  )

/**
 * Replace one server's statuses with a full read, from a poll or a live snapshot, unless a delta
 * advanced them while it was in flight. A revision other than the one held means masks drawn from
 * the old one may be stale.
 */
const applyStatusSnapshot = (
  server: ConnectedServer,
  startedRevision: string | undefined,
  snapshot: StatusSnapshot,
): ReturnType<typeof applyServerSyncSnapshot> => {
  const held = statuses.get(server.url)?.values ?? new Map<string, TemplateStatus>()
  const changed =
    held.size !== snapshot.templates.length ||
    snapshot.templates.some((status) => !sameStatus(held.get(status.templateId), status))
  const revision = snapshot.revision === undefined ? undefined : String(snapshot.revision)
  return applyServerSyncSnapshot(
    server,
    WORLD_SCOPE,
    'telemetry-status',
    startedRevision,
    { status: changed ? 'changed' : 'unchanged', ...(revision === undefined ? {} : { revision }) },
    () => {
      if (startedRevision !== undefined && revision !== undefined && revision !== startedRevision)
        invalidateServerMismatches(server.url)
      statuses.set(server.url, {
        server,
        values: new Map(snapshot.templates.map((status) => [status.templateId, status])),
      })
      if (changed) notify()
    },
  )
}

const refreshStatus = async (
  server: ConnectedServer,
  reason: ReconciliationReason,
  transport: SyncTransport,
): Promise<ServerSyncResult> => {
  if (!isCurrentServerConnection(server)) return { status: 'skipped' }
  return coalesceServerRead(
    serverConnectionIdentity(server),
    `${server.season}\u0000world\u0000status`,
    async () => {
      const startedRevision = serverSyncRevision(server, WORLD_SCOPE, 'telemetry-status')
      const answer = await backgroundRequest(server, '/telemetry/status', {
        query: { season: server.season },
        metrics: { transport, reason },
      })
      if (answer === null || !answer.response.ok || !isCurrentServerConnection(server))
        return { status: 'failed' }
      const snapshot = statusSnapshotFrom(answer.body, false)
      if (snapshot === null) return { status: 'failed' }
      // Applying the snapshot records its result with the scheduler, unless a delta overtook it,
      // so the refresh itself reports nothing to record.
      applyStatusSnapshot(server, startedRevision, snapshot)
      return { status: 'skipped' }
    },
  )
}

/** Keep every connected server's template statuses current. */
export const installServerStatus = (): void => {
  registerServerSyncResource({
    id: 'telemetry-status',
    live: true,
    scope: () => WORLD_SCOPE,
    refresh: refreshStatus,
    applyLiveEvent: (server, event) => {
      if (event.type === 'status-snapshot') {
        const snapshot = statusSnapshotFrom(event.status, true)
        return (
          snapshot !== null &&
          applyStatusSnapshot(
            server,
            serverSyncRevision(server, WORLD_SCOPE, 'telemetry-status'),
            snapshot,
          ) === 'applied'
        )
      }
      const delta = event.type === 'status-delta' ? statusDeltaFrom(event.delta) : null
      if (delta === null) return false
      applyStatusDelta(server, delta)
      return true
    },
  })
}
