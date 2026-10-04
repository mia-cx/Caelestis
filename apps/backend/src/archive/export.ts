import { sha256Hex } from '@caelestis/shared'
import { COUNTER_ARCHIVE_TABLES, type CounterArchiveTable } from '../coordination/telemetry.js'
import {
  ARCHIVE_CHAIN_SEED,
  ARCHIVE_FORMAT,
  ARCHIVE_OBJECT_PREFIXES,
  ARCHIVE_TABLES,
  ARCHIVE_VERSION,
  ArchiveError,
  type ArchiveHeader,
  type ArchiveJson,
  type ArchiveRecord,
  type ArchiveRow,
  type ArchiveTable,
  archiveSchema,
  chainLine,
  countKey,
  decodeBase64,
  encodeBase64,
} from './format.js'
import { type ArchiveOperationRow, readArchiveOperation } from './gate.js'
import {
  changedError,
  finishPendingRelease,
  holdFor,
  holdServer,
  phaseOf,
  releaseServer,
  transition,
} from './operation.js'
import type { ArchiveHost } from './port.js'

type Step =
  | { readonly kind: 'header' }
  | { readonly kind: 'rows' | 'links'; readonly table: ArchiveTable }
  | { readonly kind: 'counters'; readonly table: CounterArchiveTable }
  | { readonly kind: 'backfill' }
  | { readonly kind: 'objects'; readonly prefix: string }
  | { readonly kind: 'end' }

/** Export order. Restoring in this order satisfies every foreign key as rows arrive. */
const STEPS: readonly Step[] = [
  { kind: 'header' },
  ...ARCHIVE_TABLES.map((table) => ({ kind: 'rows' as const, table })),
  ...ARCHIVE_TABLES.filter((table) => table.deferred.length > 0).map((table) => ({
    kind: 'links' as const,
    table,
  })),
  ...Object.keys(COUNTER_ARCHIVE_TABLES).map((table) => ({
    kind: 'counters' as const,
    table: table as CounterArchiveTable,
  })),
  { kind: 'backfill' },
  ...ARCHIVE_OBJECT_PREFIXES.map((prefix) => ({ kind: 'objects' as const, prefix })),
  { kind: 'end' },
]

/** Where the next page starts. Opaque to clients, who pass it back unchanged. */
interface ExportCursor {
  readonly operationId: string
  readonly step: number
  /** Last key values, object listing position, or backfill key within the current step. */
  readonly after: ArchiveJson
  readonly template: string | null
  readonly chain: string
  readonly counts: Readonly<Record<string, number>>
}

/**
 * Pages stay well inside Worker memory and invocation limits. Operations count every query,
 * Durable Object call, and object read, including ones that emit nothing.
 */
const PAGE_RECORDS = 500
const PAGE_BYTES = 8 * 1024 * 1024
const PAGE_OPERATIONS = 400
const ROW_PAGE = 200
/** Column names, quotes, and separators around a row's text values. */
const ROW_OVERHEAD_BYTES = 512
const OBJECT_PAGE = 50
const UNKNOWN_CONTENT_TYPE = 'application/octet-stream'

const encodeCursor = (cursor: ExportCursor): string =>
  encodeBase64(new TextEncoder().encode(JSON.stringify(cursor)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')

const decodeCursor = (token: string): ExportCursor => {
  try {
    return JSON.parse(
      new TextDecoder().decode(decodeBase64(token.replaceAll('-', '+').replaceAll('_', '/'))),
    ) as ExportCursor
  } catch {
    throw new ArchiveError(
      'The export cursor is not valid. Restart the export from the beginning.',
      400,
    )
  }
}

const quoted = (name: string) => `"${name}"`
const where = (conditions: readonly string[]) =>
  conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`

/** Logical values: booleans as booleans and integers as numbers on every dialect. */
const logicalRow = (table: ArchiveTable, raw: Record<string, unknown>, only: Set<string>) =>
  Object.fromEntries(
    [...table.columns]
      .filter(([name]) => only.has(name))
      .map(([name, column]) => {
        const value = raw[name]
        return [
          name,
          value === null || value === undefined
            ? null
            : (column.mapFromDriverValue(value) as ArchiveRow[string]),
        ]
      }),
  ) as ArchiveRow

/**
 * Complete `freezing`, whether this call created it or a crashed or concurrent start left it.
 * Freezing again is harmless, and only one caller's compare-and-set publishes `frozen`.
 */
const settleFreeze = async (
  host: ArchiveHost,
  operation: ArchiveOperationRow,
): Promise<ArchiveOperationRow> => {
  if (phaseOf(operation) === 'frozen') return operation
  if (phaseOf(operation) !== 'freezing')
    throw new ArchiveError('This export is finishing. Start a new one.', 409)
  await holdFor(host, operation)
  const frozen = await transition(host, operation, { phase: 'frozen' })
  if (frozen !== null) return frozen
  const current = await readArchiveOperation(host.connection)
  if (current?.operationId === operation.operationId && phaseOf(current) === 'frozen')
    return current
  throw changedError()
}

/** Freeze the server, or finish freezing it; pages are readable as soon as this returns. */
export const startExport = async (host: ArchiveHost) => {
  const current = await finishPendingRelease(host)
  const operation =
    current?.kind === 'export' && phaseOf(current) === 'freezing'
      ? current
      : await holdServer(host, 'export', { phase: 'freezing' })
  const frozen = await settleFreeze(host, operation)
  return { id: frozen.operationId, readyAt: frozen.startedAt }
}

/** End an export and resume writes. A source being retired can stay frozen instead. */
export const finishExport = async (host: ArchiveHost): Promise<boolean> => {
  const operation = await readArchiveOperation(host.connection)
  if (operation?.kind !== 'export') return false
  if (!(await releaseServer(host, operation))) throw changedError()
  return true
}

/**
 * One bounded page of the frozen dataset. Repeating a cursor repeats its page byte for byte, so
 * an interrupted download resumes from the last cursor it saved.
 */
export const exportPage = async (
  host: ArchiveHost,
  token: string | null,
): Promise<{ readonly lines: readonly string[]; readonly next: string | null }> => {
  const current = await readArchiveOperation(host.connection)
  if (current?.kind !== 'export')
    throw new ArchiveError('Start an export before reading pages.', 409)
  const operation = await settleFreeze(host, current)
  let cursor: ExportCursor =
    token === null
      ? {
          operationId: operation.operationId,
          step: 0,
          after: null,
          template: null,
          chain: ARCHIVE_CHAIN_SEED,
          counts: {},
        }
      : decodeCursor(token)
  if (cursor.operationId !== operation.operationId)
    throw new ArchiveError(
      'This cursor belongs to an earlier export. Restart from the beginning.',
      409,
    )

  const lines: string[] = []
  let bytes = 0
  let chain = cursor.chain
  const counts = { ...cursor.counts }
  const emit = async (record: ArchiveRecord) => {
    const line = JSON.stringify(record)
    lines.push(line)
    bytes += line.length
    chain = await chainLine(chain, line)
    const key = countKey(record)
    if (key !== null) counts[key] = (counts[key] ?? 0) + 1
  }
  /** Database queries, Durable Object calls, and object reads made for this page. */
  let operations = 0
  /** Set when the next row would not fit in what is left of this page. */
  let pageFull = false
  const room = () => PAGE_RECORDS - lines.length
  const full = () => pageFull || room() <= 0 || bytes >= PAGE_BYTES || operations >= PAGE_OPERATIONS
  const advance = (patch: Partial<ExportCursor>) => {
    cursor = { ...cursor, ...patch }
  }

  while (cursor.step < STEPS.length && !full()) {
    const step = STEPS[cursor.step] as Step
    const next = () => advance({ step: cursor.step + 1, after: null, template: null })
    switch (step.kind) {
      case 'header': {
        const header: ArchiveHeader = {
          kind: 'header',
          format: ARCHIVE_FORMAT,
          version: ARCHIVE_VERSION,
          id: operation.operationId,
          createdAt: operation.startedAt,
          source: { serverId: host.serverId },
          ...archiveSchema(),
        }
        await emit(header)
        next()
        break
      }
      case 'rows':
      case 'links': {
        const { table } = step
        const limit = Math.min(room(), ROW_PAGE)
        const selected =
          step.kind === 'rows' ? [...table.columns.keys()] : [...table.key, ...table.deferred]
        const key = table.key.map(quoted).join(', ')
        const conditions = [
          ...(Array.isArray(cursor.after)
            ? [`(${key}) > (${table.key.map(() => '?').join(', ')})`]
            : []),
          ...(step.kind === 'links'
            ? [`(${table.deferred.map((column) => `${quoted(column)} IS NOT NULL`).join(' OR ')})`]
            : []),
        ]
        const lower = Array.isArray(cursor.after) ? cursor.after : []
        // Measure before fetching: lengths carry no payload, so only rows that fit are read.
        const text = selected.filter((name) => table.columns.get(name)?.columnType === 'SQLiteText')
        const size = text.length
          ? text.map((name) => `COALESCE(LENGTH(${quoted(name)}), 0)`).join(' + ')
          : '0'
        const sized = await host.connection
          .prepare(
            `SELECT ${key}, ${size} AS "archive_size" FROM ${quoted(table.name)}${where(conditions)} ORDER BY ${key} LIMIT ${limit}`,
          )
          .bind(...lower)
          .all<Record<string, unknown>>()
        operations += 1
        let space = PAGE_BYTES - bytes
        let take = 0
        for (const row of sized.results) {
          const cost = Number(row.archive_size) + ROW_OVERHEAD_BYTES
          // A row larger than a whole page still goes out, alone on an otherwise empty page.
          if ((take > 0 || lines.length > 0) && cost > space) break
          space -= cost
          take += 1
        }
        if (sized.results.length === 0) {
          next()
          break
        }
        const last = sized.results[take - 1]
        if (last === undefined) {
          pageFull = true
          break
        }
        const upper = table.key.map((name) => last[name] as string | number)
        const result = await host.connection
          .prepare(
            `SELECT ${selected.map(quoted).join(', ')} FROM ${quoted(table.name)}${where([...conditions, `(${key}) <= (${table.key.map(() => '?').join(', ')})`])} ORDER BY ${key}`,
          )
          .bind(...lower, ...upper)
          .all<Record<string, unknown>>()
        operations += 1
        for (const raw of result.results) {
          const values = logicalRow(table, raw, new Set(selected))
          await emit({
            kind: step.kind === 'rows' ? 'row' : 'link',
            table: table.name,
            values:
              step.kind === 'rows'
                ? { ...values, ...Object.fromEntries(table.deferred.map((name) => [name, null])) }
                : values,
          })
        }
        if (sized.results.length < limit && take === sized.results.length) next()
        else advance({ after: upper })
        break
      }
      case 'counters': {
        const limit = Math.min(room(), ROW_PAGE)
        const rows = await host.counters.exportCounterRows(
          step.table,
          Array.isArray(cursor.after) ? (cursor.after as (string | number)[]) : null,
          limit,
        )
        operations += 1
        for (const values of rows) await emit({ kind: 'counter', table: step.table, values })
        const last = rows.at(-1)
        if (rows.length < limit || last === undefined) next()
        else
          advance({
            after: COUNTER_ARCHIVE_TABLES[step.table].key.map((name) => last[name] ?? null),
          })
        break
      }
      case 'backfill': {
        const templateId =
          cursor.template ??
          (
            await host.connection
              .prepare(
                `SELECT "id" FROM "templates"${typeof cursor.after === 'string' ? ' WHERE "id" > ?' : ''} ORDER BY "id" LIMIT 1`,
              )
              .bind(...(typeof cursor.after === 'string' ? [cursor.after] : []))
              .first<{ id: string }>()
          )?.id
        if (cursor.template === null) operations += 1
        if (templateId === undefined) {
          next()
          break
        }
        const limit = Math.min(room(), ROW_PAGE)
        const startAfter = cursor.template === null ? null : (cursor.after as string)
        // Most templates never ran an import; each visit still costs a call, so it counts.
        const entries = await host.backfill(templateId).exportState(startAfter, limit)
        operations += 1
        for (const [key, value] of entries)
          await emit({ kind: 'backfill', templateId, key, value: value as ArchiveJson })
        const last = entries.at(-1)
        // Between templates `after` holds the finished template's id; within one, its last key.
        if (entries.length < limit || last === undefined)
          advance({ template: null, after: templateId })
        else advance({ template: templateId, after: last[0] })
        break
      }
      case 'objects': {
        const position = (cursor.after ?? {}) as { cursor?: string; skip?: number }
        const page = await host.objects.list(step.prefix, {
          ...(position.cursor === undefined ? {} : { cursor: position.cursor }),
          limit: OBJECT_PAGE,
        })
        operations += 1
        let skip = position.skip ?? 0
        for (const key of page.keys.slice(skip)) {
          if (full()) break
          const object = await host.objects.get(key)
          operations += 1
          if (object === null)
            throw new ArchiveError(
              `Object ${key} disappeared during the export. Restart the export.`,
              409,
            )
          await emit({
            kind: 'object',
            key,
            sha256: await sha256Hex(object.bytes),
            // S3 reports its default type for objects stored without one; both mean "unknown".
            ...(object.contentType === undefined || object.contentType === UNKNOWN_CONTENT_TYPE
              ? {}
              : { contentType: object.contentType }),
            metadata: object.metadata,
            data: encodeBase64(object.bytes),
          })
          skip += 1
        }
        if (skip < page.keys.length) advance({ after: { ...position, skip } })
        else if (page.cursor === undefined) next()
        else advance({ after: { cursor: page.cursor, skip: 0 } })
        break
      }
      case 'end':
        await emit({ kind: 'end', counts, chain })
        next()
        break
    }
  }
  return {
    lines,
    next: cursor.step < STEPS.length ? encodeCursor({ ...cursor, chain, counts }) : null,
  }
}
