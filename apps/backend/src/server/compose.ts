import type { ObjectStorage } from '@caelestis/storage'
import {
  CoordinatedStatusReadModel,
  type StatusShard,
} from '../adapters/coordinated-status-read-model.js'
import type { SqlConnection } from '../adapters/sql-connection.js'
import { createApp } from '../app.js'
import type { CounterArchive } from '../archive/port.js'
import type { LiveSyncPort } from '../live/port.js'
import type { CounterStore } from '../ports/index.js'
import type { PresencePort, PresenceRooms } from '../presence/port.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'
import type { BackfillHandle } from './backfill.js'
import type { ServerConfig } from './config.js'
import { serverInfo } from './info.js'
import { portableJobs } from './jobs.js'
import type { PortableStores } from './stores.js'

/**
 * What a host supplies: its storage, and how it reaches its coordinators, as Durable Object stubs
 * or objects in this process. Everything else is built here, the same way on every host.
 */
export interface HostBindings {
  /** The raw database. Archive operations are the one writer the gate admits. */
  readonly connection: SqlConnection
  readonly objects: ObjectStorage
  /** `portableStores(connection, objects)`, which the host's coordinators also write through. */
  readonly stores: PortableStores
  readonly serverId: string
  readonly counters: CounterStore & CounterArchive
  readonly statusShard: (season: number) => StatusShard
  readonly connectLive: LiveSyncPort['connect']
  readonly presenceRoom: PresenceRooms
  readonly backfill: (name: string) => Omit<BackfillHandle, 'step'>
  /** Reconcile the alarm wakeup with the earliest durable probe. */
  readonly scheduleAlarms: () => Promise<void>
}

/** Build the context, app, and periodic jobs over one host's bindings. */
export const composeBackend = (host: HostBindings, config: ServerConfig) => {
  const { counters, presenceRoom, backfill, scheduleAlarms } = host
  const statusReadModel = new CoordinatedStatusReadModel(host.statusShard, scheduleAlarms)
  const stores = { ...host.stores, counters, statusReadModel }
  const presence: PresencePort = {
    publishRegions: (season, surface) =>
      presenceRoom(season, surface).publishRegions(season, surface),
    readIngestTimings: async (season, surface, reset) =>
      presenceRoom(season, surface).readIngestTimings(reset),
    online: (season, surface) => presenceRoom(season, surface).online(),
    connect: async (request, connection) => {
      const { season, tokenHash, surface } = connection
      // The season's status shard routes revocation to rooms. It must know this room before the
      // room admits the socket, or revoking the credential would miss a hibernating room.
      if (connection.revocable)
        await statusReadModel.registerPresenceSurface(season, tokenHash, surface)
      return presenceRoom(season, surface).connect(request, connection)
    },
  }
  const context = makeBackendContext(stores.blobs, stores.sql, counters, statusReadModel, {
    presence,
    liveSync: { connect: host.connectLive },
    backfill,
  })
  const app = createApp(context, {
    server: serverInfo(config, host.serverId),
    currentSeason: config.season,
    bootstrapAdminToken: config.adminToken,
    archive: {
      connection: host.connection,
      objects: host.objects,
      counters,
      backfill,
      serverId: host.serverId,
      activated: scheduleAlarms,
      settleMilliseconds: config.archiveSettleMilliseconds,
    },
  })
  return { app, stores, jobs: portableJobs(stores, config, scheduleAlarms) }
}

export type Backend = ReturnType<typeof composeBackend>
