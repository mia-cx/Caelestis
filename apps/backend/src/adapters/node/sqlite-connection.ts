import { serialQueue } from '../../runtime/serial-queue.js'
import { sqliteConstraintViolation } from '../constraint-violation.js'
import type { SqliteDatabase, SqliteValue } from '../database-driver.js'
import type {
  SqlConnection,
  SqlResult,
  SqlStatement,
  TransactionalSqlConnection,
} from '../sql-connection.js'
import {
  DriverStatement,
  type Executed,
  runBatch,
  type StatementDriver,
} from './driver-statement.js'
import { assertUnchanged, readMigrations } from './migrations.js'
import { nodeSqliteDatabase } from './sqlite-driver.js'

const binding = (value: unknown): SqliteValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  )
    return value
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError('Unsupported SQL binding')
}

/** Persistent SQLite connection with serialized access across asynchronous transaction callbacks. */
export class SqliteConnection
  implements TransactionalSqlConnection, StatementDriver<SqliteDatabase>
{
  readonly dialect = 'sqlite'
  readonly sqlite: SqliteDatabase
  private readonly queue = serialQueue()

  constructor(filename: string, sqlite: SqliteDatabase = nodeSqliteDatabase(filename)) {
    this.sqlite = sqlite
    this.sqlite.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000',
    )
  }

  withClient<T>(operation: (sqlite: SqliteDatabase) => Promise<T>): Promise<T> {
    return this.queue(() => operation(this.sqlite))
  }

  /** Run one statement, throwing SQLite's constraint failures as typed violations. */
  async execute(
    sqlite: SqliteDatabase,
    query: string,
    values: readonly unknown[],
  ): Promise<Executed> {
    try {
      const statement = sqlite.prepare(query)
      const bound = values.map(binding)
      const columns = statement.columns()
      if (columns.length === 0)
        return { rows: [], columns, changes: Number(statement.run(...bound).changes) }
      const rows = statement.raw(...bound) as unknown[][]
      return { rows, columns, changes: /\breturning\b/i.test(query) ? rows.length : 0 }
    } catch (error) {
      throw sqliteConstraintViolation(error) ?? error
    }
  }

  /** SQLite reads the previous count natively with `changes()`. */
  async setPreviousChanges(): Promise<void> {}

  prepare(query: string): SqlStatement {
    return new DriverStatement(this, query)
  }

  transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    return this.withClient(async (sqlite) => {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const result = await operation({
          dialect: this.dialect,
          prepare: (query) => new DriverStatement(this, query, [], sqlite),
          batch: (statements) => runBatch(this, sqlite, statements),
        })
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    })
  }

  batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return this.transaction((connection) => connection.batch<T>(statements))
  }

  /** Apply immutable migrations once, recording their digest in the same transaction. */
  migrate(directory: string): void {
    this.sqlite.exec(
      'CREATE TABLE IF NOT EXISTS caelestis_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)',
    )
    for (const migration of readMigrations(directory)) {
      const applied = this.sqlite
        .prepare('SELECT sha256 FROM caelestis_migrations WHERE name = ?')
        .get(migration.name)
      if (applied) {
        assertUnchanged(migration, String(applied.sha256))
        continue
      }
      // Historic table-rebuild migrations require foreign keys disabled outside their transaction.
      this.sqlite.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
      try {
        this.sqlite.exec(migration.source)
        if (this.sqlite.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error(`Foreign key violation after ${migration.name}`)
        this.sqlite
          .prepare('INSERT INTO caelestis_migrations VALUES (?, ?)')
          .run(migration.name, migration.digest)
        this.sqlite.exec('COMMIT')
      } catch (error) {
        this.sqlite.exec('ROLLBACK')
        throw error
      } finally {
        this.sqlite.exec('PRAGMA foreign_keys = ON')
      }
    }
  }

  close(): void {
    this.sqlite.close()
  }
}
