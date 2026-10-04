import { getTableColumns, getTableName } from 'drizzle-orm'
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { COUNTER_ARCHIVE_TABLES, type CounterArchiveTable } from '../coordination/telemetry.js'
import * as schema from '../db/schema.js'

/**
 * Caelestis server archives: newline-delimited JSON, one record per line.
 *
 * The first line is a `header` and the last an `end`. Everything between is logical data with no
 * provider identifiers: rows keyed by column name, coordinator state, and object bytes. Each line
 * extends a SHA-256 chain that the `end` record states, so a reordered, edited, or truncated
 * archive fails before anything is activated.
 */
export const ARCHIVE_FORMAT = 'caelestis-server-archive'
export const ARCHIVE_VERSION = 1

export type ArchiveValue = string | number | boolean | null
export type ArchiveJson =
  | ArchiveValue
  | readonly ArchiveJson[]
  | { readonly [key: string]: ArchiveJson }
export type ArchiveRow = Readonly<Record<string, ArchiveValue>>

export interface ArchiveHeader {
  readonly kind: 'header'
  readonly format: typeof ARCHIVE_FORMAT
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly source: { readonly serverId: string }
  /** Column names per relational table, so a destination can prove compatibility up front. */
  readonly tables: Readonly<Record<string, readonly string[]>>
  readonly counters: Readonly<Record<string, readonly string[]>>
  readonly objects: readonly string[]
}

export type ArchiveRecord =
  | ArchiveHeader
  | { readonly kind: 'row'; readonly table: string; readonly values: ArchiveRow }
  /** Self- and cyclic references, applied once every row of every table exists. */
  | { readonly kind: 'link'; readonly table: string; readonly values: ArchiveRow }
  | { readonly kind: 'counter'; readonly table: string; readonly values: ArchiveRow }
  | {
      readonly kind: 'backfill'
      readonly templateId: string
      readonly key: string
      readonly value: ArchiveJson
    }
  | { readonly kind: 'backfill-alarm'; readonly templateId: string; readonly at: number }
  | {
      readonly kind: 'object'
      readonly key: string
      readonly sha256: string
      readonly contentType?: string
      readonly metadata: Readonly<Record<string, string>>
      /** Base64 bytes. */
      readonly data: string
    }
  | {
      readonly kind: 'end'
      readonly counts: Readonly<Record<string, number>>
      readonly chain: string
    }

export interface ArchiveTable {
  readonly name: string
  readonly table: SQLiteTable
  /** Column name → drizzle column, in declaration order. */
  readonly columns: ReadonlyMap<string, SQLiteColumn>
  readonly key: readonly string[]
  /** Nullable references restored as links after every row exists. */
  readonly deferred: readonly string[]
  /** A row the migrations seed, which the archive replaces instead of conflicting with. */
  readonly seeded: boolean
}

const describe = (
  table: SQLiteTable,
  options: { deferred?: readonly string[]; seeded?: boolean } = {},
): ArchiveTable => {
  const columns = new Map(
    Object.values(getTableColumns(table)).map((column) => [column.name, column]),
  )
  const config = getTableConfig(table)
  const composite = config.primaryKeys[0]?.columns.map((column) => column.name)
  return {
    name: getTableName(table),
    table,
    columns,
    key: composite ?? [...columns.values()].filter((column) => column.primary).map((c) => c.name),
    deferred: options.deferred ?? [],
    seeded: options.seeded ?? false,
  }
}

/**
 * Every server-owned relational table, in restore order: each table follows the tables its
 * non-deferred foreign keys reference.
 */
export const ARCHIVE_TABLES: readonly ArchiveTable[] = [
  describe(schema.serverSettings),
  describe(schema.accessTokens),
  describe(schema.tags),
  describe(schema.nodes, { deferred: ['parent_id'] }),
  describe(schema.nodeTags),
  describe(schema.templates, { deferred: ['current_version_id'] }),
  describe(schema.templateVersions),
  describe(schema.versionTiles),
  describe(schema.templateTags),
  describe(schema.statusReadModelRevisions),
  describe(schema.telemetryBuckets),
  describe(schema.painterTelemetryBuckets),
  describe(schema.painterBucketCollection, { seeded: true }),
  describe(schema.contributions),
  describe(schema.appliedEvents),
  describe(schema.painters),
  describe(schema.tileHistory),
  describe(schema.canvasTiles),
  describe(schema.tileBlobObjects),
  describe(schema.tileBlobReservations),
  describe(schema.templateTileMeasurements),
  describe(schema.templateTileStatuses),
  describe(schema.templateAlarmTileStatuses),
  describe(schema.templateAlarmStates),
  describe(schema.workItems),
  describe(schema.workActivity),
  describe(schema.workRegions),
  describe(schema.workRegionDeletions),
]

/**
 * Tables deliberately outside the archive. The GC cursor is an object-store listing token that
 * means nothing to another provider, so a restored server starts its scan from the beginning.
 */
export const UNARCHIVED_TABLES = [schema.tileBlobGcState, schema.archiveOperation].map(getTableName)

/**
 * Object-store prefixes the server owns, social previews included. Bytes and metadata travel;
 * provider etags and upload times do not.
 */
export const ARCHIVE_OBJECT_PREFIXES = [
  'branding/',
  'chunks/',
  'sources/',
  'archives/',
  'tiles/',
  'derived/',
  'social/',
] as const

export const archiveTable = (name: string): ArchiveTable | undefined =>
  ARCHIVE_TABLES.find((table) => table.name === name)

export const counterTable = (name: string): CounterArchiveTable | undefined =>
  Object.hasOwn(COUNTER_ARCHIVE_TABLES, name) ? (name as CounterArchiveTable) : undefined

/** What this server writes, and therefore what it can restore. */
export const archiveSchema = () => ({
  tables: Object.fromEntries(
    ARCHIVE_TABLES.map((table) => [table.name, [...table.columns.keys()]]),
  ),
  counters: Object.fromEntries(
    Object.entries(COUNTER_ARCHIVE_TABLES).map(([name, table]) => [name, [...table.columns]]),
  ),
  objects: [...ARCHIVE_OBJECT_PREFIXES],
})

/** An archive problem the administrator can act on. Nothing has been activated when it is thrown. */
export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 413 | 422 = 422,
    /** When a refused request may be retried unchanged. */
    readonly retryAt?: number,
  ) {
    super(message)
  }
}

const SHA256 = /^[0-9a-f]{64}$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isScalar = (value: unknown): value is ArchiveValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value))
const isRow = (value: unknown): value is ArchiveRow =>
  isRecord(value) && Object.values(value).every(isScalar)
const isStrings = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
const isColumnLists = (value: unknown): value is Record<string, string[]> =>
  isRecord(value) &&
  Object.values(value).every(
    (columns) => Array.isArray(columns) && columns.every((column) => typeof column === 'string'),
  )

/** Decode one archive line, refusing anything that is not exactly a known record shape. */
export const parseArchiveLine = (line: string, position: number): ArchiveRecord => {
  const invalid = (reason: string) =>
    new ArchiveError(`Archive record ${position} is invalid: ${reason}.`)
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw invalid('it is not JSON')
  }
  if (!isRecord(value)) throw invalid('it is not an object')
  switch (value.kind) {
    case 'header':
      if (value.format !== ARCHIVE_FORMAT) throw invalid('it is not a Caelestis server archive')
      if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version))
        throw invalid('the version is missing')
      if (
        typeof value.id !== 'string' ||
        typeof value.createdAt !== 'number' ||
        !isRecord(value.source) ||
        typeof value.source.serverId !== 'string' ||
        !isColumnLists(value.tables) ||
        !isColumnLists(value.counters) ||
        !Array.isArray(value.objects) ||
        !value.objects.every((prefix) => typeof prefix === 'string')
      )
        throw invalid('the header is incomplete')
      return value as unknown as ArchiveHeader
    case 'row':
    case 'link':
    case 'counter':
      if (typeof value.table !== 'string' || !isRow(value.values))
        throw invalid('the row has no table or scalar values')
      return { kind: value.kind, table: value.table, values: value.values }
    case 'backfill':
      if (
        typeof value.templateId !== 'string' ||
        typeof value.key !== 'string' ||
        !('value' in value)
      )
        throw invalid('the import state is incomplete')
      return value as unknown as ArchiveRecord
    case 'backfill-alarm':
      if (typeof value.templateId !== 'string' || typeof value.at !== 'number')
        throw invalid('the import alarm is incomplete')
      return { kind: value.kind, templateId: value.templateId, at: value.at }
    case 'object':
      if (
        typeof value.key !== 'string' ||
        typeof value.sha256 !== 'string' ||
        !SHA256.test(value.sha256) ||
        typeof value.data !== 'string' ||
        !isStrings(value.metadata) ||
        (value.contentType !== undefined && typeof value.contentType !== 'string')
      )
        throw invalid('the object is incomplete')
      return value as unknown as ArchiveRecord
    case 'end':
      if (
        !isRecord(value.counts) ||
        !Object.values(value.counts).every((count) => Number.isSafeInteger(count)) ||
        typeof value.chain !== 'string' ||
        !SHA256.test(value.chain)
      )
        throw invalid('the end record is incomplete')
      return value as unknown as ArchiveRecord
    default:
      throw invalid(`kind ${JSON.stringify(value.kind)} is unknown`)
  }
}

/** The tally key each data record adds to; the end record must state the same totals. */
export const countKey = (record: ArchiveRecord): string | null => {
  switch (record.kind) {
    case 'row':
    case 'link':
    case 'counter':
      return `${record.kind}:${record.table}`
    case 'backfill':
    case 'backfill-alarm':
    case 'object':
      return record.kind
    default:
      return null
  }
}

const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** The chain value before the first line. */
export const ARCHIVE_CHAIN_SEED = '0'.repeat(64)

/** Extend the archive chain by one line, exactly as written. */
export const chainLine = async (chain: string, line: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${chain}\n${line}`)))

/** Base64 in bounded string chunks; spreading a large array into one call overflows the stack. */
export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

export const decodeBase64 = (data: string): Uint8Array => {
  let binary: string
  try {
    binary = atob(data)
  } catch {
    throw new ArchiveError('An archived object is not valid base64.')
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
