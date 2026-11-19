import { Context, Effect } from 'effect'
import { type BackfillClients, noBackfill } from '../backfill/port.js'
import { type LiveSyncPort, noLiveSync } from '../live/port.js'
import type { BlobStore, CounterStore, SqlStore } from '../ports/index.js'
import { noPresence, type PresenceRooms } from '../presence/port.js'
import { DirectStatusReadModel, type StatusReadModelPort } from '../status-read-model/port.js'

export class BlobStoreService extends Context.Service<BlobStoreService, BlobStore>()(
  '@caelestis/backend/BlobStore',
) {}

export class SqlStoreService extends Context.Service<SqlStoreService, SqlStore>()(
  '@caelestis/backend/SqlStore',
) {}

export class CounterStoreService extends Context.Service<CounterStoreService, CounterStore>()(
  '@caelestis/backend/CounterStore',
) {}

export class StatusReadModelService extends Context.Service<
  StatusReadModelService,
  StatusReadModelPort
>()('@caelestis/backend/StatusReadModel') {}

export class PresenceService extends Context.Service<PresenceService, PresenceRooms>()(
  '@caelestis/backend/Presence',
) {}

export class LiveSyncService extends Context.Service<LiveSyncService, LiveSyncPort>()(
  '@caelestis/backend/LiveSync',
) {}

export class BackfillService extends Context.Service<BackfillService, BackfillClients>()(
  '@caelestis/backend/Backfill',
) {}

export type BackendServices =
  | BlobStoreService
  | SqlStoreService
  | CounterStoreService
  | StatusReadModelService
  | PresenceService
  | LiveSyncService
  | BackfillService
export type BackendContext = Context.Context<BackendServices>

/** What a host with live sockets and import workers adds; hosts without them leave it out. */
export interface HostPorts {
  readonly presence?: PresenceRooms
  readonly liveSync?: LiveSyncPort
  readonly backfill?: BackfillClients
}

export const makeBackendContext = (
  blobs: BlobStore,
  sql: SqlStore,
  counters: CounterStore,
  statusReadModel: StatusReadModelPort = new DirectStatusReadModel(sql),
  host: HostPorts = {},
): BackendContext =>
  Context.make(BlobStoreService, blobs).pipe(
    Context.add(SqlStoreService, sql),
    Context.add(CounterStoreService, counters),
    Context.add(StatusReadModelService, statusReadModel),
    Context.add(PresenceService, host.presence ?? noPresence),
    Context.add(LiveSyncService, host.liveSync ?? noLiveSync),
    Context.add(BackfillService, host.backfill ?? noBackfill),
  )

export interface BackendRuntime {
  readonly context: BackendContext
  readonly run: <A, E>(effect: Effect.Effect<A, E, BackendServices>) => Promise<A>
  readonly runHandled: <A, E, B>(
    effect: Effect.Effect<A, E, BackendServices>,
    onError: (error: E) => B,
  ) => Promise<A | B>
}

export const createBackendRuntime = (context: BackendContext): BackendRuntime => ({
  context,
  run: (effect) => Effect.runPromise(Effect.provideContext(effect, context)),
  runHandled: (effect, onError) =>
    Effect.runPromise(
      Effect.provideContext(
        Effect.catch(effect, (error) => Effect.succeed(onError(error))),
        context,
      ),
    ),
})
