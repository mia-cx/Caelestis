import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { millis, parseWholeNumber, type TemplateSurface, uuidV7 } from '@caelestis/shared'
import type { ObjectStorage } from '@caelestis/storage'
import { statusShardName } from '../adapters/coordinated-status-read-model.js'
import { coordinatorDatabase } from '../adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../adapters/node/coordinator-storage.js'
import { MariaConnection } from '../adapters/node/mariadb-connection.js'
import { PostgresConnection } from '../adapters/node/postgres-connection.js'
import type { SqliteConnection } from '../adapters/node/sqlite-connection.js'
import { claimSqliteOwnership } from '../adapters/node/sqlite-ownership.js'
import { relationalSqlStore } from '../adapters/relational-sql-store.js'
import { runAlarmWatcherCycle, scheduleAlarmWakeup } from '../alarm-watcher-cycle.js'
import { closeProcessWrites } from '../archive/fence.js'
import { readArchiveOperation } from '../archive/operation-row.js'
import { hashToken, mintToken } from '../auth/tokens.js'
import { DurableScheduler } from '../coordination/scheduler.js'
import { TelemetryCoordinator } from '../coordination/telemetry.js'
import type { SqlStore } from '../ports/index.js'
import { parsePresenceRoomName, presenceRoomName } from '../presence/port.js'
import { PresenceCoordinator } from '../presence-coordinator.js'
import { serialQueue } from '../runtime/serial-queue.js'
import { type BackfillHandle, openBackfill } from '../server/backfill.js'
import { composeBackend } from '../server/compose.js'
import { JOB_NAMES, JOBS, type JobName } from '../server/jobs.js'
import { portableStores } from '../server/stores.js'
import { serverInfo } from '../server-info.js'
import { StatusCoordinator } from '../status-coordinator.js'
import { derivedArtifactWriter } from '../telemetry/derived-artifact-writer.js'
import { IngestTimings } from '../telemetry/ingest-timing.js'
import { AdmissionCounters, EventLoopLag, snapshotCapacity } from './capacity.js'
import type { NodeConfig } from './config.js'
import { sqliteConnection } from './database.js'
import { NodeLiveHost } from './live.js'

const DERIVED_ARTIFACT_DRAIN_TIMEOUT_MS = 10_000

/**
 * Who owns a row of durable state and its wakeup. The names are stored, so they must not change:
 * the scheduler hands back the name and `parseActor` reads it.
 */
type Actor =
  | { readonly kind: 'server' | 'telemetry' | 'alarms' }
  | { readonly kind: 'job'; readonly name: JobName }
  | { readonly kind: 'season'; readonly season: number }
  | { readonly kind: 'presence'; readonly season: number; readonly surface: TemplateSurface }
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

const parseActor = (name: string): Actor | null => {
  if (name === 'server' || name === 'telemetry' || name === 'alarms') return { kind: name }
  const job = JOB_NAMES.find((candidate) => candidate === name)
  if (job !== undefined) return { kind: 'job', name: job }
  const separator = name.indexOf(':')
  const kind = name.slice(0, separator)
  const rest = name.slice(separator + 1)
  if (kind === 'backfill') return { kind, name: rest }
  if (kind === 'presence') {
    const room = parsePresenceRoomName(rest)
    return room === null ? null : { kind, ...room }
  }
  const season = parseWholeNumber(rest)
  return kind === 'season' && season !== null ? { kind, season } : null
}

/**
 * The frontend's read token: the configured one, or one this server minted and stored on first
 * start. A configured token must already exist, unless no token was stored yet.
 */
const provisionReadToken = async (
  connection: PostgresConnection | SqliteConnection | MariaConnection,
  sql: SqlStore,
  serverState: SqlCoordinatorStorage,
  configured: string | undefined,
): Promise<string> => {
  const stored = await serverState.get<string>('frontend-token')
  let readToken = configured ?? stored
  if (!stored && (!readToken || !(await sql.readAccessToken(await hashToken(readToken))))) {
    readToken ??= mintToken()
    const tokenHash = await hashToken(readToken)
    const generated = readToken
    await connection.transaction(async (transaction) => {
      await relationalSqlStore(transaction).insertAccessToken({
        tokenHash,
        label: 'Built-in frontend',
        scope: 'read',
        createdWithToken: tokenHash,
        createdAt: millis(Date.now()),
      })
      await transaction
        .prepare('INSERT INTO runtime_values (actor, key, value) VALUES (?, ?, ?)')
        .bind('server', 'frontend-token', JSON.stringify(generated))
        .run()
    })
  }
  if (!readToken) throw new Error('Missing frontend read token')
  const token = await sql.readAccessToken(await hashToken(readToken))
  if (token?.scope !== 'read')
    throw new Error(
      'CAELESTIS_READ_TOKEN must identify an active read-only token; the stored frontend token may have been revoked',
    )
  if (!stored) await serverState.put('frontend-token', readToken)
  return readToken
}

/** Open one owned runtime. HTTP starts only after migrations and durable state recover. */
export const openNodeRuntime = async (
  config: NodeConfig,
  objects: ObjectStorage,
  options: { onOwnershipLost: (error: Error) => void; refreshSocial?: () => Promise<void> },
) => {
  let releaseSqlite: (() => void) | undefined
  if (config.adapter === 'sqlite') {
    await mkdir(dirname(config.databaseFile), { recursive: true, mode: 0o700 })
    releaseSqlite = claimSqliteOwnership(config.databaseFile)
  }
  let connection: PostgresConnection | SqliteConnection | MariaConnection
  try {
    connection =
      config.adapter === 'mariadb'
        ? new MariaConnection(config.maria)
        : config.adapter === 'postgres'
          ? new PostgresConnection(config.pg)
          : sqliteConnection(config.databaseFile)
  } catch (error) {
    releaseSqlite?.()
    throw error
  }
  try {
    if (connection instanceof PostgresConnection || connection instanceof MariaConnection)
      await connection.claimOwnership(options.onOwnershipLost)
    await connection.migrate(
      join(
        import.meta.dirname,
        connection instanceof MariaConnection
          ? '../../migrations-mariadb'
          : connection instanceof PostgresConnection
            ? '../../migrations-postgres'
            : '../../migrations',
      ),
    )
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

    const seasons = new Map<number, NodeLiveHost>()
    const rooms = new Map<
      string,
      {
        season: number
        coordinator: PresenceCoordinator<ReturnType<NodeLiveHost['connect']>['client']>
        host: NodeLiveHost
      }
    >()
    const stores = portableStores(connection, objects)
    const { sql, blobs } = stores
    const server = serverInfo(config, serverId)
    const counters = new TelemetryCoordinator(database, state({ kind: 'telemetry' }), sql)
    await counters.initialize()
    const readToken = await provisionReadToken(connection, sql, serverState, config.readToken)
    const scheduleAlarms = () => scheduleAlarmWakeup(sql, alarmState)
    const room = (season: number, surface: TemplateSurface) => {
      const name = presenceRoomName(season, surface)
      const existing = rooms.get(name)
      if (existing) return existing.coordinator
      const host: NodeLiveHost = new NodeLiveHost(
        state({ kind: 'presence', season, surface }),
        () => coordinator,
      )
      // Each room keeps its own timings, as a Durable Object's isolate does.
      const coordinator = new PresenceCoordinator(host, sql, new IngestTimings())
      rooms.set(name, { season, coordinator, host })
      return coordinator
    }
    const shards = new Map<
      number,
      StatusCoordinator<ReturnType<NodeLiveHost['connect']>['client']>
    >()
    const statusShard = (season: number) => {
      const existing = shards.get(season)
      if (existing) return existing
      const host: NodeLiveHost = new NodeLiveHost(
        state({ kind: 'season', season }),
        () => coordinator,
      )
      const coordinator = new StatusCoordinator(
        host,
        sql,
        blobs,
        () => counters,
        server,
        scheduleAlarms,
        (season, tokenHash, surface) => room(season, surface).closeCredential(tokenHash),
        undefined,
        { liveSubscribers: config.liveSubscriberLimit },
      )
      shards.set(season, coordinator)
      seasons.set(season, host)
      return coordinator
    }
    const imports = new Map<string, BackfillHandle>()
    const backfill = (name: string): BackfillHandle => {
      const existing = imports.get(name)
      if (existing) return existing
      const created = openBackfill(
        state({ kind: 'backfill', name }),
        stores,
        serialQueue(),
        backfill,
      )
      imports.set(name, created)
      return created
    }
    const backend = composeBackend(
      {
        connection,
        objects,
        stores,
        serverId,
        counters,
        statusShard,
        connectLive: async (_request, connection) =>
          (await statusShard(connection.season).connect(connection)).response,
        presenceRoom: (season, surface) => {
          const coordinator = room(season, surface)
          return {
            publishRegions: (...args) => coordinator.publishRegions(...args),
            readIngestTimings: (reset) => coordinator.readIngestTimings(reset),
            online: () => coordinator.online(),
            closeCredential: (tokenHash) => coordinator.closeCredential(tokenHash),
            connect: (_request, connection) => coordinator.connect(connection),
          }
        },
        backfill,
        scheduleAlarms,
      },
      config,
    )

    const jobs: Partial<Record<JobName, () => Promise<void>>> = {
      ...backend.jobs,
      ...(options.refreshSocial ? { social: options.refreshSocial } : {}),
    }
    const wake = async (name: string): Promise<void> => {
      const actor = parseActor(name)
      switch (actor?.kind) {
        case 'telemetry':
          return counters.alarm()
        case 'alarms':
          return runAlarmWatcherCycle(backend.stores, alarmState, millis(Date.now()))
        case 'presence':
          return room(actor.season, actor.surface).alarm()
        case 'backfill':
          return backfill(actor.name).step()
        case 'job': {
          const job = jobs[actor.name]
          if (job === undefined) break
          await job()
          return state(actor).setAlarm(Date.now() + JOBS[actor.name].every)
        }
      }
      throw new Error(`Unknown durable job: ${name}`)
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
      /** This process's capacity for `/metrics`. */
      capacity: {
        admissions: new AdmissionCounters(),
        eventLoopLag,
        snapshot: () =>
          snapshotCapacity(
            [
              ...[...seasons].map(([season, host]) => ({
                kind: 'live-sync' as const,
                key: String(season),
                host,
              })),
              // Rooms are keyed by caller-chosen surfaces, so they aggregate per season to keep
              // the metric label domain bounded.
              ...[...rooms.values()].map(({ season, host }) => ({
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
        for (const host of seasons.values()) await host.close()
        for (const { coordinator, host } of rooms.values()) {
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
