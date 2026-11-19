import { join } from 'node:path'
import { type Millis, millis, uuidV7 } from '@caelestis/shared'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { coordinatorDatabase } from '../adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../adapters/node/coordinator-storage.js'
import type { SqliteConnection } from '../adapters/node/sqlite-connection.js'
import { relationalSqlStore } from '../adapters/relational-sql-store.js'
import { TelemetryCoordinator } from '../coordination/telemetry.js'
import type { SqlStore } from '../ports/sql-store.js'
import type { TileBlobStore } from '../telemetry/blobs/store.js'
import type { TemplateTileStatusRecord, TileObservation } from '../telemetry/tiles/store.js'
import { sqliteConnection } from './database.js'

/** Builds the relational stores; a test swaps in a feature subclass to inject faults or delays. */
type SqlFactory = (connection: SqliteConnection) => SqlStore

/** A private, migrated in-memory SQLite database with the production relational store over it. */
export const openMemoryDatabase = (
  store: SqlFactory = (connection) => relationalSqlStore(connection),
) => {
  const connection = sqliteConnection(':memory:')
  connection.migrate(join(import.meta.dirname, '../../migrations'))
  return { connection, sql: store(connection), close: async () => connection.close() }
}

/**
 * The production stores over `openMemoryDatabase`, wired as `openNodeRuntime` wires them. Tests and
 * the client contract suites build their backend on this, so they exercise the SQL production
 * runs. `clock` drives the counter coordinator's time.
 */
export const openMemoryStores = async (
  options: { clock?: (() => Millis) | undefined; sql?: SqlFactory | undefined } = {},
) => {
  const { connection, sql, close } = openMemoryDatabase(options.sql)
  const database = coordinatorDatabase(connection)
  await SqlCoordinatorStorage.initialize(database)
  const counters = new TelemetryCoordinator(
    database,
    new SqlCoordinatorStorage(database, 'telemetry'),
    sql,
    options.clock,
  )
  await counters.initialize()
  return { connection, sql, counters, blobs: new MemoryBlobStore(), close }
}

export type MemoryStores = Awaited<ReturnType<typeof openMemoryStores>>

const SEED_RESERVATION_MILLISECONDS = 60_000

/**
 * Record a tile observation through the reserve-then-commit path ingest uses, so seeded rows obey
 * the same "newer observation wins" rules production writes. Statuses for unpublished templates are
 * kept, as an admin reporter's would be.
 */
export const seedTileObservation = async (
  sql: TileBlobStore,
  observation: TileObservation,
  statuses: readonly TemplateTileStatusRecord[] = [],
  options: { recordHistory?: boolean; forceCurrent?: boolean } = {},
): Promise<void> => {
  const reservationId = uuidV7()
  const now = observation.observedAt
  const reserved = await sql.reserveTileBlobUpload(
    observation.hash,
    observation.hash,
    reservationId,
    now,
    millis(now + SEED_RESERVATION_MILLISECONDS),
  )
  if (reserved === null) throw new Error(`Tile blob ${observation.hash} is being deleted`)
  const committed = await sql.commitTileBlobReservation(
    reservationId,
    now,
    observation,
    statuses,
    options.recordHistory,
    options.forceCurrent,
    true,
  )
  if (committed === null) throw new Error(`Tile observation ${observation.hash} did not commit`)
}
