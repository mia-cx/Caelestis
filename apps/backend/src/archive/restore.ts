import { sha256Hex } from '@caelestis/shared'
import { validateObjectKey } from '@caelestis/storage'
import type { SqlStatement } from '../adapters/sql-connection.js'
import { COUNTER_ARCHIVE_TABLES, type CounterArchiveTable } from '../coordination/telemetry.js'
import {
  ARCHIVE_CHAIN_SEED,
  ARCHIVE_OBJECT_PREFIXES,
  ARCHIVE_TABLES,
  ARCHIVE_VERSION,
  ArchiveError,
  type ArchiveHeader,
  type ArchiveRow,
  type ArchiveTable,
  archiveTable,
  chainLine,
  counterTable,
  countKey,
  decodeBase64,
  parseArchiveLine,
} from './format.js'
import { type ArchiveOperationRow, readArchiveOperation } from './gate.js'
import { archiveReadyAt, assertSettled, holdServer, releaseServer } from './operation.js'
import type { ArchiveHost } from './port.js'

/** One append stays inside a Worker request and a D1 batch. */
export const MAX_RESTORE_LINES = 500
const DISCARD_PAGE = 128
/** A new server has its own few credentials; more means this is somebody's live server. */
const MAX_PRESERVED_TOKENS = 100

interface RestoreState {
  readonly archiveId: string
  readonly sourceServerId: string
  readonly tables: Readonly<Record<string, readonly string[]>>
  readonly chain: string
  readonly counts: Readonly<Record<string, number>>
  readonly ended: boolean
  /** False while `beginRestore` still checks the closed destination. */
  readonly ready: boolean
  /**
   * Credentials the destination held before the restore. An archived row with the same hash is the
   * same secret: the destination's row wins, so restoring never changes its scope. A discard keeps
   * these rows.
   */
  readonly preservedTokens: readonly string[]
  /** Discard progress through DISCARD_STEPS. */
  readonly discard?: { readonly step: number; readonly after: string | null }
}

const quoted = (name: string) => `"${name}"`

/** Adapters wrap driver errors; the innermost message names the violated constraint. */
const databaseReason = (error: unknown): string =>
  error instanceof Error && error.cause !== undefined
    ? databaseReason(error.cause)
    : error instanceof Error
      ? error.message
      : String(error)

const decodeState = (operation: ArchiveOperationRow) =>
  JSON.parse(operation.stateJson) as RestoreState

const restoreOperation = async (host: ArchiveHost) => {
  const operation = await readArchiveOperation(host.connection)
  if (operation?.kind !== 'import') throw new ArchiveError('No import is in progress.', 409)
  return { operation, state: decodeState(operation) }
}

/** Refuse archives this server cannot restore faithfully, naming what to change. */
const assertCompatible = (header: ArchiveHeader) => {
  if (header.version > ARCHIVE_VERSION)
    throw new ArchiveError(
      `This archive uses format version ${header.version}; this server reads version ${ARCHIVE_VERSION}. Upgrade the destination server first.`,
    )
  if (header.version < 1) throw new ArchiveError(`Archive version ${header.version} is not valid.`)
  for (const [name, columns] of Object.entries(header.tables)) {
    const table = archiveTable(name)
    const unknown = columns.filter((column) => !table?.columns.has(column))
    if (table === undefined || unknown.length > 0)
      throw new ArchiveError(
        `The archive has ${table === undefined ? `table ${name}` : `${name} columns ${unknown.join(', ')}`}, which this server does not. Upgrade the destination server first.`,
      )
    const missing = [...table.columns.values()].filter(
      (column) => column.notNull && !column.hasDefault && !columns.includes(column.name),
    )
    if (missing.length > 0)
      throw new ArchiveError(
        `The archive lacks required ${name} columns ${missing.map((column) => column.name).join(', ')}. Export it again from an upgraded source.`,
      )
  }
  for (const [name, columns] of Object.entries(header.counters)) {
    const table = counterTable(name)
    const known: readonly string[] =
      table === undefined ? [] : COUNTER_ARCHIVE_TABLES[table].columns
    if (table === undefined || columns.some((column) => !known.includes(column)))
      throw new ArchiveError(
        `The archive has counter state ${name} this server cannot read. Upgrade the destination server first.`,
      )
  }
  const prefixes: readonly string[] = ARCHIVE_OBJECT_PREFIXES
  const unknownPrefix = header.objects.find((prefix) => !prefixes.includes(prefix))
  if (unknownPrefix !== undefined)
    throw new ArchiveError(
      `The archive has ${unknownPrefix} objects this server does not store. Upgrade the destination server first.`,
    )
}

/** What the destination already holds. A restore never merges into existing data. */
const occupiedLocations = async (host: ArchiveHost): Promise<string[]> => {
  const occupied: string[] = []
  for (const table of ARCHIVE_TABLES) {
    if (table.seeded || table.name === 'access_tokens') continue
    const row = await host.connection
      .prepare(`SELECT 1 AS present FROM ${quoted(table.name)} LIMIT 1`)
      .first()
    if (row !== null) occupied.push(table.name)
  }
  for (const [table, { key }] of Object.entries(COUNTER_ARCHIVE_TABLES)) {
    if (key[0] === 'singleton') continue
    if ((await host.counters.exportCounterRows(table as CounterArchiveTable, null, 1)).length > 0)
      occupied.push(table)
  }
  for (const prefix of ARCHIVE_OBJECT_PREFIXES)
    if ((await host.objects.list(prefix, { limit: 1 })).keys.length > 0) occupied.push(prefix)
  return occupied
}

/** Prove the object store keeps bytes and metadata before any archive data lands in it. */
const probeObjects = async (host: ArchiveHost, id: string) => {
  const key = `archive-probe/${id}`
  const bytes = new Uint8Array([0xca, 0xe1, 0xe5])
  await host.objects.put(key, bytes, {
    contentType: 'application/octet-stream',
    metadata: { probe: id },
  })
  const stored = await host.objects.get(key)
  await host.objects.delete([key])
  if (
    stored === null ||
    stored.contentType !== 'application/octet-stream' ||
    stored.metadata.probe !== id ||
    stored.bytes.join() !== bytes.join()
  )
    throw new ArchiveError(
      'The destination object store did not return the bytes, content type, and metadata it was given. Check its configuration before restoring.',
      409,
    )
}

/**
 * Begin restoring into this server, or resume the same archive's interrupted restore. The server
 * answers 503 to everything else until the restore is activated or discarded.
 */
export const beginRestore = async (host: ArchiveHost, headerLine: string) => {
  const header = parseArchiveLine(headerLine, 0)
  if (header.kind !== 'header') throw new ArchiveError('An archive must start with its header.')
  assertCompatible(header)
  const current = await readArchiveOperation(host.connection)
  if (current !== null) {
    const state = current.kind === 'import' ? decodeState(current) : null
    if (state?.discard !== undefined)
      throw new ArchiveError('This restore is being discarded. Finish discarding it first.', 409)
    if (state?.archiveId !== header.id)
      throw new ArchiveError(
        current.kind === 'import'
          ? 'A different archive is being restored. Discard it before starting another.'
          : 'This server is exporting. Finish the export before restoring into it.',
        409,
      )
    return {
      id: current.operationId,
      position: current.position,
      readyAt: archiveReadyAt(host, current.startedAt),
      resumed: true,
    }
  }
  const preparing: RestoreState = {
    archiveId: header.id,
    sourceServerId: header.source.serverId,
    tables: header.tables,
    chain: await chainLine(ARCHIVE_CHAIN_SEED, headerLine),
    counts: {},
    ended: false,
    ready: false,
    preservedTokens: [],
  }
  // Decide on emptiness only once no other writer can change the answer.
  const { operationId, startedAt } = await holdServer(host, 'import', JSON.stringify(preparing), 1)
  try {
    const occupied = await occupiedLocations(host)
    if (occupied.length > 0)
      throw new ArchiveError(
        `Restore into a new server. This one already has data in ${occupied.join(', ')}.`,
        409,
      )
    const preserved = await host.connection
      .prepare(`SELECT "token_hash" FROM "access_tokens" LIMIT ${MAX_PRESERVED_TOKENS + 1}`)
      .all<{ token_hash: string }>()
    if (preserved.results.length > MAX_PRESERVED_TOKENS)
      throw new ArchiveError(
        'Restore into a new server. This one already has many credentials.',
        409,
      )
    await probeObjects(host, operationId)
    const ready: RestoreState = {
      ...preparing,
      ready: true,
      preservedTokens: preserved.results.map((row) => row.token_hash),
    }
    await host.connection
      .prepare(
        'UPDATE "archive_operation" SET "state_json" = ? WHERE "id" = 1 AND "operation_id" = ?',
      )
      .bind(JSON.stringify(ready), operationId)
      .run()
  } catch (error) {
    // Nothing was restored, so reopening hands the destination back exactly as it was.
    await releaseServer(host, operationId)
    throw error
  }
  return { id: operationId, position: 1, readyAt: archiveReadyAt(host, startedAt), resumed: false }
}

const rowValues = (table: ArchiveTable, state: RestoreState, values: ArchiveRow, at: number) => {
  const archived = state.tables[table.name]
  const names = Object.keys(values)
  if (archived === undefined || names.some((name) => !archived.includes(name)))
    throw new ArchiveError(`Archive record ${at} has columns its header does not declare.`)
  return names.map((name) => {
    const value = values[name] ?? null
    return value === null ? null : table.columns.get(name)?.mapToDriverValue(value)
  })
}

/**
 * Apply the next archive lines. Object, counter, and import-state writes are idempotent; every
 * row lands in one atomic batch that also advances the position, so a retried append either
 * finds its rows committed or applies them exactly once.
 */
export const appendRestore = async (
  host: ArchiveHost,
  position: number,
  lines: readonly string[],
) => {
  if (lines.length > MAX_RESTORE_LINES)
    throw new ArchiveError(`Send at most ${MAX_RESTORE_LINES} archive lines per request.`, 413)
  const { operation, state } = await restoreOperation(host)
  assertSettled(host, operation.startedAt)
  if (state.discard !== undefined)
    throw new ArchiveError('This restore is being discarded. Finish discarding it first.', 409)
  if (!state.ready)
    throw new ArchiveError('The restore is still checking the destination. Retry shortly.', 409)
  if (position !== operation.position)
    throw new ArchiveError(
      `The server expects archive record ${operation.position}; resume from there.`,
      409,
    )
  if (state.ended && lines.length > 0)
    throw new ArchiveError('The archive already ended. Activate the restore.', 409)

  let chain = state.chain
  let ended = state.ended
  const counts: Record<string, number> = { ...state.counts }
  const statements: SqlStatement[] = []
  // Coordinator state is grouped so a request makes one call per table or template.
  const counterRows = new Map<CounterArchiveTable, Readonly<Record<string, string | number>>[]>()
  const backfillPages = new Map<string, [string, unknown][]>()
  for (const [index, line] of lines.entries()) {
    const at = position + index
    if (ended) throw new ArchiveError(`Archive record ${at} follows the end record.`)
    const record = parseArchiveLine(line, at)
    if (record.kind === 'end') {
      if (record.chain !== chain)
        throw new ArchiveError(
          `The archive is corrupt: its checksum chain breaks before record ${at}. Export it again.`,
        )
      const keys = new Set([...Object.keys(record.counts), ...Object.keys(counts)])
      const mismatch = [...keys].filter((key) => (record.counts[key] ?? 0) !== (counts[key] ?? 0))
      if (mismatch.length > 0)
        throw new ArchiveError(
          `The archive is incomplete: counts differ for ${mismatch.join(', ')}.`,
        )
      ended = true
      continue
    }
    chain = await chainLine(chain, line)
    const key = countKey(record)
    if (key !== null) counts[key] = (counts[key] ?? 0) + 1
    switch (record.kind) {
      case 'header':
        throw new ArchiveError(`Archive record ${at} is a second header.`)
      case 'row': {
        const table = archiveTable(record.table)
        if (table === undefined || state.tables[table.name] === undefined)
          throw new ArchiveError(`Archive record ${at} names undeclared table ${record.table}.`)
        const names = Object.keys(record.values)
        const values = rowValues(table, state, record.values, at)
        // The destination already holds this secret; its own row stays as it is.
        if (
          table.name === 'access_tokens' &&
          state.preservedTokens.includes(String(record.values.token_hash))
        )
          break
        const updates = names.filter((name) => !table.key.includes(name))
        statements.push(
          host.connection
            .prepare(
              `INSERT INTO ${quoted(table.name)} (${names.map(quoted).join(', ')}) VALUES (${names.map(() => '?').join(', ')})${
                table.seeded
                  ? ` ON CONFLICT (${table.key.map(quoted).join(', ')}) DO UPDATE SET ${updates.map((name) => `${quoted(name)} = excluded.${quoted(name)}`).join(', ')}`
                  : ''
              }`,
            )
            .bind(...values),
        )
        break
      }
      case 'link': {
        const table = archiveTable(record.table)
        if (table === undefined || table.deferred.length === 0)
          throw new ArchiveError(
            `Archive record ${at} links table ${record.table}, which has none.`,
          )
        const values = rowValues(table, state, record.values, at)
        const names = Object.keys(record.values)
        const set = names.filter((name) => table.deferred.includes(name))
        const where = names.filter((name) => table.key.includes(name))
        if (where.length !== table.key.length)
          throw new ArchiveError(`Archive record ${at} does not identify its ${table.name} row.`)
        const driverValue = (name: string) => values[names.indexOf(name)]
        statements.push(
          host.connection
            .prepare(
              `UPDATE ${quoted(table.name)} SET ${set.map((name) => `${quoted(name)} = ?`).join(', ')} WHERE ${where.map((name) => `${quoted(name)} = ?`).join(' AND ')}`,
            )
            .bind(...set.map(driverValue), ...where.map(driverValue)),
        )
        break
      }
      case 'counter': {
        const table = counterTable(record.table)
        if (table === undefined)
          throw new ArchiveError(
            `Archive record ${at} names unknown counter state ${record.table}.`,
          )
        const rows = counterRows.get(table) ?? []
        rows.push(record.values as Readonly<Record<string, string | number>>)
        counterRows.set(table, rows)
        break
      }
      case 'backfill': {
        const page = backfillPages.get(record.templateId) ?? []
        page.push([record.key, record.value])
        backfillPages.set(record.templateId, page)
        break
      }
      case 'object': {
        const prefixes: readonly string[] = ARCHIVE_OBJECT_PREFIXES
        validateObjectKey(record.key)
        if (!prefixes.some((prefix) => record.key.startsWith(prefix)))
          throw new ArchiveError(
            `Archive record ${at} stores ${record.key} outside server prefixes.`,
          )
        const bytes = decodeBase64(record.data)
        if ((await sha256Hex(bytes)) !== record.sha256)
          throw new ArchiveError(
            `The archive is corrupt: object ${record.key} does not match its SHA-256. Export it again.`,
          )
        await host.objects.put(record.key, bytes, {
          ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
          metadata: record.metadata,
        })
        break
      }
    }
  }

  for (const [table, rows] of counterRows) await host.counters.importCounterRows(table, rows)
  for (const [templateId, page] of backfillPages) await host.backfill(templateId).importState(page)

  const next = position + lines.length
  const nextState: RestoreState = { ...state, chain, counts, ended }
  // A concurrent or replayed append finds the position moved, and a discard finds the state
  // changed; either way NULL violates NOT NULL and aborts the whole batch, rows included.
  const advance = host.connection
    .prepare(
      'UPDATE "archive_operation" SET "position" = CASE WHEN "position" = ? AND "state_json" = ? THEN CAST(? AS BIGINT) ELSE NULL END, "state_json" = ? WHERE "id" = 1',
    )
    .bind(position, operation.stateJson, next, JSON.stringify(nextState))
  try {
    await host.connection.batch([advance, ...statements])
  } catch (cause) {
    const current = await readArchiveOperation(host.connection)
    if (current?.stateJson !== operation.stateJson)
      throw new ArchiveError(
        `Another request changed this restore. Resume from record ${current?.position ?? position}.`,
        409,
      )
    throw new ArchiveError(
      `Archive records ${position}-${next - 1} could not be restored: ${databaseReason(cause)}`,
    )
  }
  return { position: next, ended }
}

/** Open the restored server once the archive's end record has verified every count and checksum. */
export const activateRestore = async (host: ArchiveHost) => {
  const { operation, state } = await restoreOperation(host)
  if (state.discard !== undefined)
    throw new ArchiveError('This restore is being discarded. Finish discarding it first.', 409)
  if (!state.ended)
    throw new ArchiveError(
      `The archive is incomplete: ${operation.position} records restored and no end record yet.`,
      409,
    )
  // Opens only the exact state just verified, so a discard that starts meanwhile wins.
  if (!(await releaseServer(host, operation.operationId, operation.stateJson)))
    throw new ArchiveError('Another request changed this restore. Check its status.', 409)
  await host.activated()
  return { sourceServerId: state.sourceServerId, counts: state.counts }
}

type DiscardStep =
  | { readonly kind: 'backfill' }
  | { readonly kind: 'counters' }
  | { readonly kind: 'unlink'; readonly table: ArchiveTable }
  | { readonly kind: 'rows'; readonly table: ArchiveTable }
  | { readonly kind: 'objects'; readonly prefix: string }

/** Import state needs the template ids, so it goes first; rows go in reverse dependency order. */
const DISCARD_STEPS: readonly DiscardStep[] = [
  { kind: 'backfill' },
  { kind: 'counters' },
  ...ARCHIVE_TABLES.filter((table) => table.deferred.length > 0).map((table) => ({
    kind: 'unlink' as const,
    table,
  })),
  ...ARCHIVE_TABLES.filter((table) => !table.seeded)
    .reverse()
    .map((table) => ({ kind: 'rows' as const, table })),
  ...ARCHIVE_OBJECT_PREFIXES.map((prefix) => ({ kind: 'objects' as const, prefix })),
]

/**
 * Undo a restore one bounded step per call, keeping the destination's own credentials. Returns
 * true when the server is empty and open again.
 */
export const discardRestore = async (host: ArchiveHost): Promise<boolean> => {
  const { operation, state } = await restoreOperation(host)
  const saveProgress = async (discard: NonNullable<RestoreState['discard']>) => {
    const saved = await host.connection
      .prepare(
        'UPDATE "archive_operation" SET "state_json" = ? WHERE "id" = 1 AND "operation_id" = ? AND "state_json" = ?',
      )
      .bind(JSON.stringify({ ...state, discard }), operation.operationId, operation.stateJson)
      .run()
    if (saved.meta.changes === 0)
      throw new ArchiveError('Another request changed this restore. Check its status.', 409)
  }
  // Mark the discard before deleting anything, so activation can no longer open this state.
  if (state.discard === undefined) {
    await saveProgress({ step: 0, after: null })
    return false
  }
  const progress = state.discard
  const step = DISCARD_STEPS[progress.step]
  if (step === undefined) {
    await releaseServer(host, operation.operationId)
    return true
  }
  let next: { step: number; after: string | null } = { step: progress.step + 1, after: null }
  switch (step.kind) {
    case 'backfill': {
      const template = await host.connection
        .prepare(
          `SELECT "id" FROM "templates"${progress.after === null ? '' : ' WHERE "id" > ?'} ORDER BY "id" LIMIT 1`,
        )
        .bind(...(progress.after === null ? [] : [progress.after]))
        .first<{ id: string }>()
      if (template === null) break
      const done = await host.backfill(template.id).discardState(DISCARD_PAGE)
      next = { step: progress.step, after: done ? template.id : progress.after }
      break
    }
    case 'counters':
      await host.counters.discardCounterRows()
      break
    case 'unlink':
      await host.connection
        .prepare(
          `UPDATE ${quoted(step.table.name)} SET ${step.table.deferred.map((name) => `${quoted(name)} = NULL`).join(', ')}`,
        )
        .run()
      break
    case 'rows': {
      const { table } = step
      const kept = table.name === 'access_tokens' ? state.preservedTokens : []
      const keys = await host.connection
        .prepare(
          `SELECT ${table.key.map(quoted).join(', ')} FROM ${quoted(table.name)}${kept.length === 0 ? '' : ` WHERE "token_hash" NOT IN (${kept.map(() => '?').join(', ')})`} LIMIT ${DISCARD_PAGE}`,
        )
        .bind(...kept)
        .all<Record<string, unknown>>()
      if (keys.results.length === 0) break
      await host.connection.batch(
        keys.results.map((row) =>
          host.connection
            .prepare(
              `DELETE FROM ${quoted(table.name)} WHERE ${table.key.map((name) => `${quoted(name)} = ?`).join(' AND ')}`,
            )
            .bind(...table.key.map((name) => row[name])),
        ),
      )
      next = progress
      break
    }
    case 'objects': {
      const page = await host.objects.list(step.prefix, { limit: DISCARD_PAGE })
      if (page.keys.length === 0) break
      await host.objects.delete(page.keys)
      next = progress
      break
    }
  }
  await saveProgress(next)
  return false
}

/** The current operation, for progress displays and resuming clients. */
export const archiveStatus = async (host: ArchiveHost) => {
  const operation = await readArchiveOperation(host.connection)
  if (operation === null) return { operation: null }
  const base = {
    kind: operation.kind,
    id: operation.operationId,
    startedAt: operation.startedAt,
    readyAt: archiveReadyAt(host, operation.startedAt),
  }
  if (operation.kind === 'export') return { operation: base }
  const state = decodeState(operation)
  return {
    operation: {
      ...base,
      archiveId: state.archiveId,
      sourceServerId: state.sourceServerId,
      position: operation.position,
      ended: state.ended,
      discarding: state.discard !== undefined,
      counts: state.counts,
    },
  }
}
