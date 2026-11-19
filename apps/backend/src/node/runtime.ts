import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { millis, type TemplateSurface, uuidV7 } from '@caelestis/shared'
import type { ObjectStorage } from '@caelestis/storage'
import { coordinatorDatabase } from '../adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../adapters/node/coordinator-storage.js'
import { MariaConnection } from '../adapters/node/mariadb-connection.js'
import { PostgresConnection } from '../adapters/node/postgres-connection.js'
import { DurableScheduler } from '../adapters/node/scheduler.js'
import { claimSqliteOwnership } from '../adapters/node/sqlite-ownership.js'
import { closeProcessWrites } from '../archive/fence.js'
import { readArchiveOperation } from '../archive/operation-row.js'
import { TelemetryCoordinator } from '../coordination/telemetry.js'
import { IngestTimings } from '../metrics/ingest-timing.js'
import { PresenceCoordinator } from '../presence/coordinator.js'
import { type PresenceRoomId, parsePresenceRoomName, presenceRoomName } from '../presence/port.js'
import { serialQueue } from '../runtime/serial-queue.js'
import { type BackfillHandle, openBackfill } from '../server/backfill.js'
import { composeBackend } from '../server/compose.js'
import { serverInfo } from '../server/info.js'
import { JOB_NAMES, JOBS, type JobName } from '../server/jobs.js'
import { portableStores } from '../server/stores.js'
import { StatusCoordinator } from '../status-read-model/coordinator.js'
import { statusShardName } from '../status-read-model/shard.js'
import { runAlarmWatcherCycle, scheduleAlarmWakeup } from '../telemetry/alarm-watcher-cycle.js'
import { derivedArtifactWriter } from '../telemetry/derived-artifact-writer.js'
import { AdmissionCounters, EventLoopLag, snapshotCapacity } from './capacity.js'
import type { NodeConfig } from './config.js'
import { sqliteConnection } from './database.js'
import { NodeLiveHost } from './live.js'
import { provisionReadToken } from './read-token.js'

const DERIVED_ARTIFACT_DRAIN_TIMEOUT_MS = 10_000

/** Who owns a row of durable state and its wakeup. The names are stored, so they must not change. */
type Actor =
  | { readonly kind: 'server' }
  | { readonly kind: 'season'; readonly season: number }
  | Woken

/** The actors that set wakeups, which the scheduler hands back by name. */
type Woken =
  | { readonly kind: 'telemetry' | 'alarms' }
  | { readonly kind: 'job'; readonly name: JobName }
  | ({ readonly kind: 'presence' } & PresenceRoomId)
  | { readonly kind: 'backfill'; readonly name: string }

const actorName = (actor: Actor): string => {
  switch (actor.kind) {
    case 'job':
      return actor.name
    case 'season':
      return statusShardName(actor.season)
    case 'presence':
      return `presence:${presenceRoomName(actor.season, actor.surface)}`
    case 'backfill':
      return `backfill:${actor.name}`
    default:
      return actor.kind
  }
}

/** The actor a stored wakeup belongs to, or null when no actor that sets wakeups has the name. */
const parseWoken = (name: string): Woken | null => {
  if (name === 'telemetry' || name === 'alarms') return { kind: name }
  const job = JOB_NAMES.find((candidate) => candidate === name)
  if (job !== undefined) return { kind: 'job', name: job }
  const separator = name.indexOf(':')
  const kind = name.slice(0, separator)
  const rest = name.slice(separator + 1)
  if (kind === 'backfill') return { kind, name: rest }
  if (kind !== 'presence') return null
  const room = parsePresenceRoomName(rest)
  return room === null ? null : { kind, ...room }
}

/**
 * The configured database, the migrations that shape it, and how a shared server claims it. A
 * SQLite file is claimed before it opens.
 */
const openConnection = (config: NodeConfig) => {
  switch (config.adapter) {
    case 'mariadb': {
      const connection = new MariaConnection(config.maria)
      return {
        connection,
        migrations: 'migrations-mariadb',
        claim: (lost: (error: Error) => void) => connection.claimOwnership(lost),
      }
    }
    case 'postgres': {
      const connection = new PostgresConnection(config.pg)
      return {
        connection,
        migrations: 'migrations-postgres',
        claim: (lost: (error: Error) => void) => connection.claimOwnership(lost),
      }
    }
    default:
      return { connection: sqliteConnection(config.databaseFile), migrations: 'migrations' }
  }
}

/** Values built on first use, one per key. */
const lazily = <Key, Value>(id: (key: Key) => string | number, make: (key: Key) => Value) => {
  const held = new Map<string | number, Value>()
  return {
    get: (key: Key): Value => {
      const name = id(key)
      const existing = held.get(name)
      if (existing !== undefined) return existing
      const created = make(key)
      held.set(name, created)
      return created
    },
    entries: () => held.entries(),
  }
}

type LiveCoordinator = ReturnType<ConstructorParameters<typeof NodeLiveHost>[1]>

/** A live coordinator and the host whose sockets it serves; each needs the other. */
const liveActor = <Coordinator extends LiveCoordinator>(
  storage: SqlCoordinatorStorage,
  make: (host: NodeLiveHost) => Coordinator,
) => {
  const host: NodeLiveHost = new NodeLiveHost(storage, () => coordinator)
  const coordinator = make(host)
  return { host, coordinator }
}

/** Open one owned runtime. HTTP starts only after migrations and durable state recover. */
export const openNodeRuntime = async (
  config: NodeConfig,
  objects: ObjectStorage,
  options: {
    onOwnershipLost: (error: Error) => void
    /** Render the share images through this server's API at `api`, read with its frontend token. */
    refreshSocial?: (api: string, readToken: string) => Promise<void>
  },
) => {
  let releaseSqlite: (() => void) | undefined
  if (config.adapter === 'sqlite') {
    await mkdir(dirname(config.databaseFile), { recursive: true, mode: 0o700 })
    releaseSqlite = claimSqliteOwnership(config.databaseFile)
  }
  let opened: ReturnType<typeof openConnection>
  try {
    opened = openConnection(config)
  } catch (error) {
    releaseSqlite?.()
    throw error
  }
  const { connection } = opened
  try {
    if ('claim' in opened) await opened.claim(options.onOwnershipLost)
    await connection.migrate(join(import.meta.dirname, '../..', opened.migrations))
    // A restart during an archive operation must not reopen writes the operation closed.
    const held = await readArchiveOperation(connection)
    if (held !== null) await closeProcessWrites(connection, held.operationId)
    const database = coordinatorDatabase(connection)
    await SqlCoordinatorStorage.initialize(database)
    const state = (actor: Actor) => new SqlCoordinatorStorage(database, actorName(actor))
    const serverState = state({ kind: 'server' })
    const serverId = config.serverId ?? (await serverState.get<string>('id')) ?? uuidV7()
    await serverState.put('id', serverId)
    const alarmState = state({ kind: 'alarms' })

    const stores = portableStores(connection, objects)
    const { sql, blobs } = stores
    const server = serverInfo(config, serverId)
    const counters = new TelemetryCoordinator(database, state({ kind: 'telemetry' }), sql)
    await counters.initialize()
    const readToken = await provisionReadToken(connection, sql, serverState, config.readToken)
    const scheduleAlarms = () => scheduleAlarmWakeup(sql, alarmState)
    const shards = lazily(
      (season: number) => season,
      (season) =>
        liveActor(
          state({ kind: 'season', season }),
          (host) =>
            new StatusCoordinator(
              host,
              season,
              sql,
              blobs,
              () => counters,
              server,
              scheduleAlarms,
              (tokenHash, surface): Promise<void> =>
                rooms.get({ season, surface }).coordinator.closeCredential(tokenHash),
              undefined,
              { liveSubscribers: config.liveSubscriberLimit },
            ),
        ),
    )
    const rooms = lazily(
      (room: PresenceRoomId) => presenceRoomName(room.season, room.surface),
      (room) => ({
        season: room.season,
        ...liveActor(
          state({ kind: 'presence', ...room }),
          (host) =>
            // Each room keeps its own timings, as a Durable Object's isolate does.
            new PresenceCoordinator(
              host,
              room,
              sql,
              new IngestTimings(),
              (tokenHash): Promise<void> =>
                shards
                  .get(room.season)
                  .coordinator.registerPresenceSurface(tokenHash, room.surface),
            ),
        ),
      }),
    )
    const backfills = lazily(
      (name: string) => name,
      (name): BackfillHandle =>
        openBackfill(state({ kind: 'backfill', name }), stores, serialQueue(), backfills.get),
    )
    const backend = composeBackend(
      {
        connection,
        objects,
        stores,
        serverId,
        counters,
        statusShard: (season) => shards.get(season).coordinator,
        connectLive: async (_request, live) =>
          (await shards.get(live.season).coordinator.connect(live)).response,
        presenceRoom: (season: number, surface: TemplateSurface) =>
          rooms.get({ season, surface }).coordinator,
        backfill: backfills.get,
        scheduleAlarms,
      },
      config,
    )

    const { refreshSocial } = options
    // Set by `start`, which runs jobs only once the listener has bound its port; `PORT=0` binds
    // one the config does not know.
    let api: string | undefined
    const jobs: Partial<Record<JobName, () => Promise<void>>> = {
      ...backend.jobs,
      ...(refreshSocial
        ? {
            social: () =>
              api === undefined
                ? Promise.reject(new Error('Share images render through a listening server'))
                : refreshSocial(api, readToken),
          }
        : {}),
    }
    const wake = async (name: string): Promise<void> => {
      const actor = parseWoken(name)
      switch (actor?.kind) {
        case 'telemetry':
          return counters.alarm()
        case 'alarms':
          return runAlarmWatcherCycle(backend.stores, alarmState, millis(Date.now()))
        case 'presence':
          return rooms.get(actor).coordinator.alarm()
        case 'backfill':
          return backfills.get(actor.name).step()
        case 'job': {
          const job = jobs[actor.name]
          if (job === undefined) break
          await job()
          return state(actor).setAlarm(Date.now() + JOBS[actor.name].every)
        }
      }
      // Retrying a wakeup nothing handles, such as a job this process no longer runs, could
      // never succeed. Returning lets the scheduler delete it.
      console.warn(`Dropped a durable wakeup nothing handles: ${name}`)
    }
    const scheduler = new DurableScheduler(database, wake)
    await scheduleAlarms()
    for (const name of JOB_NAMES) {
      if (jobs[name] === undefined) continue
      const job = state({ kind: 'job', name })
      if ((await job.getAlarm()) === null) await job.setAlarm(Date.now() + JOBS[name].every)
    }
    const eventLoopLag = new EventLoopLag()
    let closed = false
    return {
      app: backend.app,
      sql,
      counters,
      scheduler,
      objects,
      readToken,
      serverId,
      connection,
      /** Run durable jobs, now that the listener has bound `port`. */
      start(port: number) {
        api = `http://127.0.0.1:${port}${config.basePath}/v1/`
        scheduler.start()
      },
      capacity: {
        admissions: new AdmissionCounters(),
        eventLoopLag,
        snapshot: () =>
          snapshotCapacity(
            [
              ...[...shards.entries()].map(([season, { host }]) => ({
                kind: 'live-sync' as const,
                key: String(season),
                host,
              })),
              // Rooms are keyed by caller-chosen surfaces, so they aggregate per season to keep
              // the metric label domain bounded.
              ...[...rooms.entries()].map(([, { season, host }]) => ({
                kind: 'presence' as const,
                key: String(season),
                host,
              })),
            ],
            config.liveSubscriberLimit,
          ),
      },
      async close() {
        if (closed) return
        closed = true
        eventLoopLag.stop()
        await scheduler.stop()
        for (const [, { host }] of shards.entries()) await host.close()
        for (const [, { coordinator, host }] of rooms.entries()) {
          await host.close()
          coordinator.stop()
        }
        // Queued mismatch artifacts are reconstructible; give them a bounded chance to land.
        await Promise.race([
          derivedArtifactWriter.drain(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, DERIVED_ARTIFACT_DRAIN_TIMEOUT_MS).unref?.(),
          ),
        ])
        await connection.close()
        releaseSqlite?.()
      },
    }
  } catch (error) {
    await connection.close()
    releaseSqlite?.()
    throw error
  }
}

export type NodeRuntime = Awaited<ReturnType<typeof openNodeRuntime>>
