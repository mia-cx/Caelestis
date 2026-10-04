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
import {
  type ArchiveLease,
  type ArchiveOperationRow,
  archiveFence,
  readArchiveOperation,
  StaleArchiveOperationError,
} from './gate.js'
import {
  ArchiveLeaseDeadline,
  archiveReadyAt,
  assertSettled,
  changedError,
  checkArchiveDeadline,
  finishPendingRelease,
  holdFor,
  holdServer,
  phaseOf,
  releaseServer,
  transition,
  withArchiveLease,
} from './operation.js'
import type { ArchiveHost } from './port.js'

/** One append stays inside a Worker request and a D1 batch. */
export const MAX_RESTORE_LINES = 500
const DISCARD_PAGE = 128
/** Backfill ids one discard call verifies in its final pass; the rest resume on the next call. */
const DISCARD_VERIFY_PAGE = 500
/** A new server has its own few credentials; more means this is somebody's live server. */
const MAX_PRESERVED_TOKENS = 100

interface RestoreState {
  readonly archiveId: string
  readonly sourceServerId: string
  readonly tables: Readonly<Record<string, readonly string[]>>
  readonly chain: string
  readonly counts: Readonly<Record<string, number>>
  readonly ended: boolean
  /** See the lifecycle in operation.ts. Records arrive only while `ready`. */
  readonly phase: 'preparing' | 'ready' | 'discarding' | 'releasing'
  /**
   * Credentials the destination held before the restore. An archived row with the same hash is the
   * same secret: the destination's row wins, so restoring never changes its scope. A discard keeps
   * these rows.
   */
  readonly preservedTokens: readonly string[]
  /**
   * Discard progress through DISCARD_STEPS. `templates` records the ids whose backfill state
   * the discard must clean, captured before any template rows are deleted so a late backfill
   * write can still be found without them.
   */
  readonly discard?: {
    readonly step: number
    readonly after: string | null
    readonly templates?: readonly string[]
    /** Backfill ids already checked in the final pass, so a large restore resumes there. */
    readonly verified?: number
  }
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
  for (const [table, { key, columns }] of Object.entries(COUNTER_ARCHIVE_TABLES)) {
    const rows = await host.counters.exportCounterRows(table as CounterArchiveTable, null, 1)
    // A seeded singleton row always exists, so only a non-seed value counts as occupied.
    const seeded = key[0] === 'singleton'
    const residue = seeded
      ? rows.some((row) =>
          columns.some(
            (column) => !(key as readonly string[]).includes(column) && Number(row[column]) !== 0,
          ),
        )
      : rows.length > 0
    if (residue) occupied.push(table)
  }
  for (const prefix of ARCHIVE_OBJECT_PREFIXES)
    if ((await host.objects.list(prefix, { limit: 1 })).keys.length > 0) occupied.push(prefix)
  return occupied
}

/**
 * Prove the object store keeps bytes and metadata before any archive data lands in it. Each
 * attempt owns its key, so preparations that overlap cannot delete each other's probe.
 */
const probeObjects = async (host: ArchiveHost, operationId: string) => {
  const id = `${operationId}/${crypto.randomUUID()}`
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
export const beginRestore = async (host: ArchiveHost, headerLine: string) =>
  withArchiveLease(host, (lease) => beginRestoreHeld(host, lease, headerLine))

const beginRestoreHeld = async (host: ArchiveHost, lease: ArchiveLease, headerLine: string) => {
  const header = parseArchiveLine(headerLine, 0)
  if (header.kind !== 'header') throw new ArchiveError('An archive must start with its header.')
  assertCompatible(header)
  const current = await finishPendingRelease(host)
  if (current !== null) {
    if (current.kind !== 'import')
      throw new ArchiveError(
        'This server is exporting. Finish the export before restoring into it.',
        409,
      )
    const state = decodeState(current)
    if (state.archiveId !== header.id)
      throw new ArchiveError(
        'A different archive is being restored. Discard it before starting another.',
        409,
      )
    if (state.phase === 'discarding')
      throw new ArchiveError('This restore is being discarded. Finish discarding it first.', 409)
    // A preparation that crashed or is still running is finished here; it is idempotent.
    const ready = state.phase === 'preparing' ? await prepare(host, lease, current) : current
    return {
      id: ready.operationId,
      position: ready.position,
      readyAt: archiveReadyAt(host, ready.startedAt),
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
    phase: 'preparing',
    preservedTokens: [],
  }
  const ready = await prepare(host, lease, await holdServer(host, 'import', preparing))
  return {
    id: ready.operationId,
    position: ready.position,
    readyAt: archiveReadyAt(host, ready.startedAt),
    resumed: false,
  }
}

/**
 * Establish, behind the closed gate, that the destination is empty and which credentials are
 * its own, then publish `ready`. Every step only reads or probes, so any caller may repeat it;
 * the compare-and-set lets exactly one publish, and loses to a cancellation that came first.
 */
const prepare = async (
  host: ArchiveHost,
  lease: ArchiveLease,
  operation: ArchiveOperationRow,
): Promise<ArchiveOperationRow> => {
  await holdFor(host, operation)
  // From here this operation may import counters until its discard or release says otherwise.
  await host.counters.beginCounterImport(operation.operationId)
  let preserved: string[]
  try {
    const occupied = await occupiedLocations(host)
    if (occupied.length > 0)
      throw new ArchiveError(
        `Restore into a new server. This one already has data in ${occupied.join(', ')}.`,
        409,
      )
    const tokens = await host.connection
      .prepare(`SELECT "token_hash" FROM "access_tokens" LIMIT ${MAX_PRESERVED_TOKENS + 1}`)
      .all<{ token_hash: string }>()
    if (tokens.results.length > MAX_PRESERVED_TOKENS)
      throw new ArchiveError(
        'Restore into a new server. This one already has many credentials.',
        409,
      )
    preserved = tokens.results.map((row) => row.token_hash)
    checkArchiveDeadline(lease)
    await probeObjects(host, operation.operationId)
  } catch (error) {
    // A refusal restored nothing, so cancelling hands the destination back as it was. The
    // compare-and-set keeps a cancellation or another preparer's outcome intact.
    if (error instanceof ArchiveError) await releaseServer(host, operation)
    throw error
  }
  const ready = await transition(host, operation, {
    ...decodeState(operation),
    phase: 'ready',
    preservedTokens: preserved,
  })
  if (ready !== null) return ready
  const current = await readArchiveOperation(host.connection)
  if (current?.operationId === operation.operationId && decodeState(current).phase === 'ready')
    return current
  throw changedError()
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
) => withArchiveLease(host, (lease) => appendRestoreHeld(host, lease, position, lines))

const appendRestoreHeld = async (
  host: ArchiveHost,
  lease: ArchiveLease,
  position: number,
  lines: readonly string[],
) => {
  if (lines.length > MAX_RESTORE_LINES)
    throw new ArchiveError(`Send at most ${MAX_RESTORE_LINES} archive lines per request.`, 413)
  const { operation, state } = await restoreOperation(host)
  assertSettled(host, operation.startedAt)
  if (state.phase === 'preparing')
    throw new ArchiveError(
      'The restore is still checking the destination. Send the header again to finish that.',
      409,
    )
  if (state.phase !== 'ready')
    throw new ArchiveError('This restore is being discarded or released. Check its status.', 409)
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
        checkArchiveDeadline(lease)
        await host.objects.put(record.key, bytes, {
          ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
          metadata: record.metadata,
        })
        break
      }
    }
  }

  // Counter and backfill writes are idempotent; each is checked against the call's deadline,
  // and counters also against the operation's own grant, so a stale call cannot repopulate.
  try {
    for (const [table, rows] of counterRows) {
      checkArchiveDeadline(lease)
      await host.counters.importCounterRows(operation.operationId, table, rows)
    }
  } catch (error) {
    if (error instanceof StaleArchiveOperationError) throw changedError()
    throw error
  }
  for (const [templateId, page] of backfillPages) {
    checkArchiveDeadline(lease)
    await host.backfill(templateId).importState(page)
  }

  const next = position + lines.length
  const nextState: RestoreState = { ...state, chain, counts, ended }
  // The fence aborts the whole batch unless the operation still carries exactly this state and
  // the lease is still this call's — a stale call commits nothing, rows included.
  const advance = host.connection
    .prepare(
      'UPDATE "archive_operation" SET "position" = ?, "state_json" = ? WHERE "id" = 1 AND "operation_id" = ? AND "position" = ? AND "state_json" = ?',
    )
    .bind(next, JSON.stringify(nextState), operation.operationId, position, operation.stateJson)
  try {
    await host.connection.batch([
      archiveFence(host.connection, operation, lease),
      advance,
      ...statements,
    ])
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
export const activateRestore = async (host: ArchiveHost) =>
  withArchiveLease(host, () => activateRestoreHeld(host))

const activateRestoreHeld = async (host: ArchiveHost) => {
  const { operation, state } = await restoreOperation(host)
  if (state.discard !== undefined) {
    // A discard that already reached releasing is finished, never activated.
    if (state.phase === 'releasing') await releaseServer(host, operation)
    throw new ArchiveError('This restore is being discarded. Finish discarding it first.', 409)
  }
  if (!state.ended)
    throw new ArchiveError(
      `The archive is incomplete: ${operation.position} records restored and no end record yet.`,
      409,
    )
  // Moves only the exact state just verified, so a discard that starts meanwhile wins. A release
  // that an earlier activation left half done is finished here instead.
  if (!(await releaseServer(host, operation))) throw changedError()
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
export const discardRestore = async (
  host: ArchiveHost,
  verifyPage = DISCARD_VERIFY_PAGE,
): Promise<boolean> =>
  withArchiveLease(host, (lease) => discardRestoreHeld(host, lease, verifyPage))

const discardRestoreHeld = async (
  host: ArchiveHost,
  lease: ArchiveLease,
  verifyPage: number,
): Promise<boolean> => {
  const { operation, state } = await restoreOperation(host)
  // Nothing was restored before `ready`, and releasing only finishes: neither deletes anything.
  if (state.phase === 'preparing' || state.phase === 'releasing') {
    if (!(await releaseServer(host, operation))) throw changedError()
    return true
  }
  const saveProgress = async (discard: NonNullable<RestoreState['discard']>) => {
    if ((await transition(host, operation, { ...state, phase: 'discarding', discard })) === null)
      throw changedError()
  }
  // Mark the discard before deleting anything, so activation can no longer open this state.
  // The lease serializes discard callers, and the compare-and-set claim backs it up: a stale
  // caller whose lease was taken over changes nothing.
  if (state.phase === 'ready') {
    await saveProgress({ step: 0, after: null })
    // The claim won: from here this operation's counter imports are refused while its own
    // cleanup may still run. A crash before this is covered at the top of the next call.
    await host.counters.beginCounterDiscard(operation.operationId)
    return false
  }
  const progress = state.discard ?? { step: 0, after: null }
  // Idempotent: a discard that crashed right after claiming the row revokes imports here.
  await host.counters.beginCounterDiscard(operation.operationId)
  try {
    const step = DISCARD_STEPS[progress.step]
    if (step === undefined) {
      // A cheap extra pass: an in-flight write that outlived its own lease deadline may have
      // landed after its step ran, so check every location one more time before releasing.
      const occupied = await occupiedLocations(host)
      const ids = progress.templates ?? []
      const from = progress.verified ?? 0
      let verified = from
      try {
        while (occupied.length === 0 && verified < ids.length) {
          checkArchiveDeadline(lease)
          const templateId = ids[verified]
          if (templateId === undefined) break
          if ((await host.backfill(templateId).exportState(null, 1)).length > 0)
            occupied.push(`backfill:${templateId}`)
          verified += 1
          if (verified - from >= verifyPage) break
        }
      } catch (error) {
        // Out of lease time: the checkpoint already made lets the next call resume here.
        if (error instanceof ArchiveLeaseDeadline) {
          await saveProgress({
            step: DISCARD_STEPS.length,
            after: null,
            templates: ids,
            verified,
          })
          return false
        }
        throw error
      }
      if (occupied.length > 0) {
        // Restart from the recorded ids: the template rows are already gone, so the ids
        // cannot be discovered again.
        await saveProgress({ step: 0, after: null, templates: ids })
        return false
      }
      if (verified < ids.length) {
        await saveProgress({
          step: DISCARD_STEPS.length,
          after: null,
          templates: ids,
          verified,
        })
        return false
      }
      if (!(await releaseServer(host, operation))) throw changedError()
      return true
    }
    let next: NonNullable<RestoreState['discard']> = {
      step: progress.step + 1,
      after: null,
      ...(progress.templates === undefined ? {} : { templates: progress.templates }),
    }
    switch (step.kind) {
      case 'backfill': {
        // Record the ids to clean before any template rows are deleted: a late backfill write
        // outlives its row, and later steps can no longer discover the ids through the table.
        if (progress.templates === undefined) {
          const ids = await host.connection
            .prepare('SELECT "id" FROM "templates" ORDER BY "id"')
            .all<{ id: string }>()
          next = {
            step: progress.step,
            after: null,
            templates: ids.results.map((row) => row.id),
          }
          break
        }
        const index = progress.after === null ? 0 : progress.templates.indexOf(progress.after) + 1
        const templateId = progress.templates[index]
        if (templateId === undefined) break
        checkArchiveDeadline(lease)
        const done = await host.backfill(templateId).discardState(DISCARD_PAGE)
        next = {
          step: progress.step,
          after: done ? templateId : progress.after,
          templates: progress.templates,
        }
        break
      }
      case 'counters':
        checkArchiveDeadline(lease)
        try {
          await host.counters.discardCounterRows(operation.operationId)
        } catch (error) {
          if (error instanceof StaleArchiveOperationError) throw changedError()
          throw error
        }
        break
      case 'unlink':
        checkArchiveDeadline(lease)
        await host.connection.batch([
          archiveFence(host.connection, operation, lease),
          host.connection.prepare(
            `UPDATE ${quoted(step.table.name)} SET ${step.table.deferred.map((name) => `${quoted(name)} = NULL`).join(', ')}`,
          ),
        ])
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
        checkArchiveDeadline(lease)
        await host.connection.batch([
          archiveFence(host.connection, operation, lease),
          ...keys.results.map((row) =>
            host.connection
              .prepare(
                `DELETE FROM ${quoted(table.name)} WHERE ${table.key.map((name) => `${quoted(name)} = ?`).join(' AND ')}`,
              )
              .bind(...table.key.map((name) => row[name])),
          ),
        ])
        next = progress
        break
      }
      case 'objects': {
        const page = await host.objects.list(step.prefix, { limit: DISCARD_PAGE })
        if (page.keys.length === 0) break
        checkArchiveDeadline(lease)
        await host.objects.delete(page.keys)
        next = progress
        break
      }
    }
    await saveProgress(next)
  } catch (error) {
    // Out of lease time: progress already saved is picked up by the next call.
    if (error instanceof ArchiveLeaseDeadline) {
      await saveProgress(progress)
      return false
    }
    throw error
  }
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
    // `releasing` still holds the server; any lifecycle call finishes it.
    phase: phaseOf(operation),
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
