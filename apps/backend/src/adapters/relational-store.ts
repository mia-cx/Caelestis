import { relationalDatabase } from './relational-database.js'
import type { SqlConnection } from './sql-connection.js'
import { sqlDialect } from './sql-dialect.js'

/**
 * What every relational feature store is built on: one connection, already fenced by the archive
 * gate, with a drizzle builder and the dialect's few differing expressions over it.
 */
export abstract class RelationalStore {
  protected readonly database: ReturnType<typeof relationalDatabase>
  protected readonly syntax: ReturnType<typeof sqlDialect>

  constructor(protected readonly client: SqlConnection) {
    this.database = relationalDatabase(client)
    this.syntax = sqlDialect(client.dialect)
  }
}

export const chunkRows = <T>(rows: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let offset = 0; offset < rows.length; offset += size) {
    out.push(rows.slice(offset, offset + size))
  }
  return out
}

export interface ColourStatus {
  readonly index: number
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly total: number
}

export const parseColourTotals = (
  value: string | null,
): readonly { readonly index: number; readonly total: number }[] | undefined => {
  if (value === null) return undefined
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed)
    ? (parsed as readonly { readonly index: number; readonly total: number }[])
    : undefined
}

export const parseColourStatuses = (value: string): readonly ColourStatus[] => {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) ? (parsed as readonly ColourStatus[]) : []
}
