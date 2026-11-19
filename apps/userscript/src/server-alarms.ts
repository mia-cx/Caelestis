import type { Alarm, ReconciliationReason, SyncTransport } from '@caelestis/shared'
import { notifyListeners } from './listeners.js'
import { PerServerMap } from './per-server-map.js'
import {
  type ConnectedServer,
  connectedServers,
  isCurrentServerConnection,
  onServerRemoved,
  serverConnectionIdentity,
} from './server-connections.js'
import type { ServerTemplate } from './server-manifest.js'
import { admittedManifest, type ManifestCoverage, manifestCoverage } from './server-manifests.js'
import { coalesceServerRead } from './server-read-coalescer.js'
import { serverRequest } from './server-request.js'
import {
  applyServerSyncRevision,
  registerServerSyncResource,
  type ServerSyncResult,
  WORLD_SCOPE,
} from './server-sync-coordinator.js'
import { isScopeVisible, onStateChange, type ServerConnection } from './settings.js'
import { alarmsSnapshotFrom } from './telemetry-wire.js'
import { nodeChainVisible } from './templates/server-nodes.js'
import { serverScopeKey, serverTemplateKey } from './tree-keys.js'

/**
 * Each server's open grief episodes per template. Alarms are read against the manifest coverage
 * current at the time, so a changed manifest hides them until they are read again.
 */

const alarms = new PerServerMap<{
  readonly server: ConnectedServer
  readonly coverage: ManifestCoverage
  readonly value: Alarm
}>()
/** Coverage whose alarms have been read at least once. */
const alarmsKnown = new WeakSet<ManifestCoverage>()
const listeners = new Set<() => void>()
/** The active alarms listeners last heard about; held values are replaced only when they change. */
let notifiedAlarms: readonly Alarm[] = []

onServerRemoved((serverUrl) => {
  alarms.forget(serverUrl)
})

const notify = (): void => {
  notifiedAlarms = activeServerAlarms().map(({ alarm }) => alarm)
  notifyListeners(listeners, 'alarm listener failed')
}

export const onServerAlarmChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Hold exactly these alarms for one server, read against `coverage`; whether anything changed. */
const applyAlarms = (
  server: ConnectedServer,
  coverage: ManifestCoverage,
  next: readonly Alarm[],
): boolean => {
  let changed = !alarmsKnown.has(coverage)
  alarmsKnown.add(coverage)
  const present = new Set<string>()
  for (const alarm of next) {
    present.add(alarm.templateId)
    const held = alarms.get(server.url, alarm.templateId)
    if (held?.coverage === coverage && JSON.stringify(held.value) === JSON.stringify(alarm))
      continue
    alarms.set(server.url, alarm.templateId, { server, coverage, value: alarm })
    changed = true
  }
  for (const [templateId] of alarms.entries(server.url)) {
    if (present.has(templateId)) continue
    alarms.delete(server.url, templateId)
    changed = true
  }
  if (changed) notify()
  return changed
}

const refreshAlarms = async (
  server: ConnectedServer,
  reason: ReconciliationReason,
  transport: SyncTransport,
): Promise<ServerSyncResult> => {
  const coverage = manifestCoverage(server)
  if (coverage === null) return { status: 'skipped' }
  return coalesceServerRead(
    serverConnectionIdentity(server),
    `${server.season}\u0000world\u0000alarms`,
    async () => {
      const answer = await serverRequest(server, '/telemetry/alarms', {
        query: { season: server.season },
        limits: 'background',
        read: 'json',
        retry: true,
        metrics: { transport, reason },
      }).catch(() => null)
      if (answer === null || !answer.response.ok || manifestCoverage(server) !== coverage)
        return { status: 'failed' }
      const read = alarmsSnapshotFrom(answer.body, false)
      if (read === null) return { status: 'failed' }
      const changed = applyAlarms(server, coverage, read.alarms)
      return {
        status: changed ? 'changed' : 'unchanged',
        ...(read.version === undefined ? {} : { revision: read.version }),
      }
    },
  )
}

const hasTemplate = (server: ServerConnection, templateId: string): boolean =>
  admittedManifest(server)?.templates.some((template) => template.id === templateId) === true

const alarmEnabled = (server: ConnectedServer, template: ServerTemplate): boolean =>
  isScopeVisible(serverScopeKey(server.url)) &&
  isScopeVisible(serverTemplateKey(server.url, template.id)) &&
  nodeChainVisible(server.url, template.nodeId)

/** Current authoritative episode, including templates hidden from the canvas. */
export const serverAlarmFor = (
  server: ServerConnection,
  template: Pick<ServerTemplate, 'id' | 'nodeId' | 'published'>,
): Alarm | null => {
  const known = alarms.get(server.url, template.id)
  if (
    known === undefined ||
    !isCurrentServerConnection(known.server) ||
    known.coverage !== manifestCoverage(server) ||
    !hasTemplate(server, template.id)
  )
    return null
  return known.value
}

/** Current alarm kind, confirmed absence, or undefined while telemetry is unknown. */
export const serverAlarmKindFor = (
  server: ServerConnection,
  template: Pick<ServerTemplate, 'id' | 'nodeId' | 'published'>,
): Alarm['kind'] | 'none' | undefined => {
  const coverage = manifestCoverage(server)
  if (coverage === null || !alarmsKnown.has(coverage) || !hasTemplate(server, template.id))
    return undefined
  return serverAlarmFor(server, template)?.kind ?? 'none'
}

/** Every open episode on a template that is switched on. */
export const activeServerAlarms = (): readonly {
  server: ConnectedServer
  template: ServerTemplate
  alarm: Alarm
}[] =>
  connectedServers().flatMap((server) =>
    (admittedManifest(server)?.templates ?? []).flatMap((template) => {
      if (!alarmEnabled(server, template)) return []
      const alarm = serverAlarmFor(server, template)
      return alarm === null ? [] : [{ server, template, alarm }]
    }),
  )

/** Keep every connected server's alarms current. */
export const installServerAlarms = (): void => {
  // State decides which alarms are active (hidden scopes, connected servers). Most changes leave
  // them alone, and every listener redraws on a notification.
  onStateChange(() => {
    const active = activeServerAlarms()
    if (
      active.length !== notifiedAlarms.length ||
      active.some(({ alarm }, index) => alarm !== notifiedAlarms[index])
    )
      notify()
  })
  registerServerSyncResource({
    id: 'telemetry-alarms',
    live: true,
    // Alarms are read against coverage, so there is nothing to read before the first manifest.
    scope: (server) => (manifestCoverage(server) !== null ? WORLD_SCOPE : null),
    refresh: refreshAlarms,
    applyLiveEvent: (server, event) => {
      if (event.type !== 'alarms-snapshot') return false
      const coverage = manifestCoverage(server)
      const read = alarmsSnapshotFrom(event.alarms, true)
      if (coverage === null || read?.version === undefined) return false
      applyAlarms(server, coverage, read.alarms)
      applyServerSyncRevision(server, WORLD_SCOPE, 'telemetry-alarms', read.version)
      return true
    },
  })
}
