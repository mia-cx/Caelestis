export type SqliteValue = null | number | bigint | string | Uint8Array

/** The synchronous SQLite binding a `SqliteConnection` drives: `node:sqlite` or `bun:sqlite`. */
export interface SqliteDatabase {
  exec(query: string): void
  close(): void
  prepare(query: string): {
    columns(): readonly unknown[]
    all(...values: SqliteValue[]): Record<string, unknown>[]
    get(...values: SqliteValue[]): Record<string, unknown> | undefined
    run(...values: SqliteValue[]): { changes: number | bigint }
    raw(...values: SqliteValue[]): unknown[]
  }
}
