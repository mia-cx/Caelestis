import type { CoordinatorDatabase } from './database.js'

/** The three counts every counter row carries. */
export const COUNTER_VALUES = ['placed', 'correct', 'repairs'] as const

interface CounterTable {
  /** The primary key, which also orders an archive's keyset pages. */
  readonly key: readonly string[]
  readonly columns: readonly string[]
  /** The singleton row a new coordinator starts with. */
  readonly seed?: readonly number[]
}

const BUCKET_KEY = ['template_id', 'bucket_start_s'] as const
const BUCKET_COLUMNS = [...BUCKET_KEY, ...COUNTER_VALUES] as const

/** Durable coordinator tables in archive order. */
export const COUNTER_ARCHIVE_TABLES = {
  pending_counters: { key: BUCKET_KEY, columns: BUCKET_COLUMNS },
  flush_batch: { key: BUCKET_KEY, columns: BUCKET_COLUMNS },
  retained_counters: { key: BUCKET_KEY, columns: BUCKET_COLUMNS },
  counter_meta: { key: ['template_id'], columns: ['template_id', 'flushed_at'] },
  counter_stats: {
    key: ['singleton'],
    columns: ['singleton', 'dropped_late_deltas'],
    seed: [1, 0],
  },
  flush_retry_state: {
    key: ['singleton'],
    columns: ['singleton', 'consecutive_failures'],
    seed: [1, 0],
  },
  applied_counter_events: { key: ['event_id'], columns: ['event_id', 'seen_at_ms'] },
} as const satisfies Record<string, CounterTable>
export type CounterArchiveTable = keyof typeof COUNTER_ARCHIVE_TABLES

/** Every other column is a count or a timestamp. */
const TEXT_COLUMNS: ReadonlySet<string> = new Set(['template_id', 'event_id'])

/** Tables that record archive operations, which an archive never carries. */
const OPERATIONS: Readonly<Record<string, string>> = {
  counter_freeze: 'operation_id VARCHAR(128) PRIMARY KEY',
  counter_archive_operation:
    'operation_id VARCHAR(128) PRIMARY KEY, state BIGINT NOT NULL, uses BIGINT NOT NULL DEFAULT 0',
}

const INDEXES = [
  'applied_counter_events_seen_at_idx ON applied_counter_events (seen_at_ms)',
  'retained_counters_bucket_idx ON retained_counters (bucket_start_s)',
  'pending_counters_bucket_idx ON pending_counters (bucket_start_s)',
]

const createTable = (name: string, { key, columns: names }: CounterTable): string => {
  const [only] = key
  const columns = names.map((column) => {
    const type = TEXT_COLUMNS.has(column) ? 'TEXT' : 'BIGINT'
    if (key.length === 1 && column === only)
      return `${column} ${type} PRIMARY KEY${column === 'singleton' ? ' CHECK (singleton = 1)' : ''}`
    return `${column} ${type} NOT NULL`
  })
  if (key.length > 1) columns.push(`PRIMARY KEY (${key.join(', ')})`)
  return `CREATE TABLE IF NOT EXISTS ${name} (${columns.join(', ')})`
}

/** Restore the singleton rows a new coordinator starts with, keeping any that exist. */
export const seedCounterTables = async (database: CoordinatorDatabase): Promise<void> => {
  for (const [name, table] of Object.entries(COUNTER_ARCHIVE_TABLES)) {
    if (!('seed' in table)) continue
    await database.run(
      `INSERT INTO ${name} (${table.columns.join(', ')}) VALUES (${table.seed.join(', ')}) ON CONFLICT DO NOTHING`,
    )
  }
}

/** Create the tables a deployed Durable Object already has, on any coordinator database. */
export const initializeCounterTables = async (database: CoordinatorDatabase): Promise<void> => {
  for (const [name, table] of Object.entries(COUNTER_ARCHIVE_TABLES))
    await database.run(createTable(name, table))
  for (const [name, columns] of Object.entries(OPERATIONS))
    await database.run(`CREATE TABLE IF NOT EXISTS ${name} (${columns})`)
  for (const index of INDEXES) await database.run(`CREATE INDEX IF NOT EXISTS ${index}`)
  await seedCounterTables(database)
}

/**
 * Activity not yet in D1, one row per contributing bucket: every pending delta, plus the part of
 * a batch being flushed that the last successful flush has not retained. `matches` filters a
 * template id column, so callers choose one template or several.
 */
export const outstandingRows = (matches: (column: string) => string): string => `
  SELECT template_id, ${COUNTER_VALUES.join(', ')}
  FROM pending_counters
  WHERE ${matches('template_id')}
  UNION ALL
  SELECT batch.template_id, ${COUNTER_VALUES.map(
    (value) => `batch.${value} - COALESCE(retained.${value}, 0) AS ${value}`,
  ).join(', ')}
  FROM flush_batch AS batch
  LEFT JOIN retained_counters AS retained
    ON retained.template_id = batch.template_id
   AND retained.bucket_start_s = batch.bucket_start_s
  WHERE ${matches('batch.template_id')}
`

/**
 * A bucket's full cumulative value once its pending delta joins it: pending, plus the batch being
 * flushed when there is one and the retained value otherwise. Binds `?1` template and `?2` bucket.
 */
export const CUMULATIVE_BUCKET = `SELECT ${COUNTER_VALUES.map(
  (value) => `
    COALESCE((SELECT ${value} FROM pending_counters WHERE template_id = ?1 AND bucket_start_s = ?2), 0)
    + COALESCE(
      (SELECT ${value} FROM flush_batch WHERE template_id = ?1 AND bucket_start_s = ?2),
      (SELECT ${value} FROM retained_counters WHERE template_id = ?1 AND bucket_start_s = ?2),
      0
    ) AS ${value}`,
).join(',')}`
