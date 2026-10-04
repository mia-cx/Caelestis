import { sha256Hex, uuidV7 } from '@caelestis/shared'
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
import { ARCHIVE_SETTLE_MILLISECONDS, readArchiveOperation } from './gate.js'
import type { ArchiveHost } from './port.js'

/** When an operation that closed the gate at `startedAt` may touch data. */
export const archiveReadyAt = (host: ArchiveHost, startedAt: number): number =>
  startedAt + (host.settleMilliseconds ?? ARCHIVE_SETTLE_MILLISECONDS)

/** Refuse data access until every cached gate read and in-flight write has expired. */
export const assertSettled = (host: ArchiveHost, startedAt: number): void => {
  const readyAt = archiveReadyAt(host, startedAt)
  if (Date.now() < readyAt)
    throw new ArchiveError('In-flight writes are still settling. Retry shortly.', 409, readyAt)
}

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

/** Pages stay well inside Worker memory and subrequest limits. */
const PAGE_RECORDS = 500
const PAGE_BYTES = 8 * 1024 * 1024
const ROW_PAGE = 200
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
const after = (key: readonly string[], values: ArchiveJson) =>
  Array.isArray(values)
    ? ` WHERE (${key.map(quoted).join(', ')}) > (${key.map(() => '?').join(', ')})`
    : ''

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

export const startExport = async (host: ArchiveHost) => {
  const now = Date.now()
  const operationId = uuidV7()
  try {
    await host.connection
      .prepare(
        'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, ?, ?, ?, 0, ?)',
      )
      .bind('export', operationId, now, '{}')
      .run()
  } catch (cause) {
    if ((await readArchiveOperation(host.connection)) !== null)
      throw new ArchiveError('Another archive operation is in progress.', 409)
    throw cause
  }
  return { id: operationId, readyAt: archiveReadyAt(host, now) }
}

/** End an export and resume writes. A source being retired can stay frozen instead. */
export const finishExport = async (host: ArchiveHost): Promise<boolean> =>
  (
    await host.connection
      .prepare('DELETE FROM "archive_operation" WHERE "id" = 1 AND "kind" = ?')
      .bind('export')
      .run()
  ).meta.changes > 0

/**
 * One bounded page of the frozen dataset. Repeating a cursor repeats its page byte for byte, so
 * an interrupted download resumes from the last cursor it saved.
 */
export const exportPage = async (
  host: ArchiveHost,
  token: string | null,
): Promise<{ readonly lines: readonly string[]; readonly next: string | null }> => {
  const operation = await readArchiveOperation(host.connection)
  if (operation?.kind !== 'export')
    throw new ArchiveError('Start an export before reading pages.', 409)
  assertSettled(host, operation.startedAt)
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
  const room = () => PAGE_RECORDS - lines.length
  const full = () => room() <= 0 || bytes >= PAGE_BYTES
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
        const linked = table.deferred.map((column) => `${quoted(column)} IS NOT NULL`).join(' OR ')
        const keyset = after(table.key, cursor.after)
        const where =
          step.kind === 'rows' ? keyset : `${keyset ? `${keyset} AND` : ' WHERE'} (${linked})`
        const result = await host.connection
          .prepare(
            `SELECT ${selected.map(quoted).join(', ')} FROM ${quoted(table.name)}${where} ORDER BY ${table.key.map(quoted).join(', ')} LIMIT ${limit}`,
          )
          .bind(...(Array.isArray(cursor.after) ? cursor.after : []))
          .all<Record<string, unknown>>()
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
        const last = result.results.at(-1)
        if (result.results.length < limit || last === undefined) next()
        else advance({ after: table.key.map((name) => last[name] as string | number) })
        break
      }
      case 'counters': {
        const limit = Math.min(room(), ROW_PAGE)
        const rows = await host.counters.exportCounterRows(
          step.table,
          Array.isArray(cursor.after) ? (cursor.after as (string | number)[]) : null,
          limit,
        )
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
        if (templateId === undefined) {
          next()
          break
        }
        const limit = Math.min(room(), ROW_PAGE)
        const startAfter = cursor.template === null ? null : (cursor.after as string)
        const page = await host.backfill(templateId).exportState(startAfter, limit)
        for (const [key, value] of page.entries)
          await emit({ kind: 'backfill', templateId, key, value: value as ArchiveJson })
        if (page.alarm !== null) await emit({ kind: 'backfill-alarm', templateId, at: page.alarm })
        const last = page.entries.at(-1)
        // Between templates `after` holds the finished template's id; within one, its last key.
        if (page.entries.length < limit || last === undefined)
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
        let skip = position.skip ?? 0
        for (const key of page.keys.slice(skip)) {
          if (full()) break
          const object = await host.objects.get(key)
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
