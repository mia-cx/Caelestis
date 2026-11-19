import {
  type Connection,
  type ConnectionConfig,
  createConnection,
  type RowsWithMeta,
  SqlError,
  type UpsertResult,
} from 'mariadb'
import { causes } from '../../runtime/errors.js'
import { serialQueue } from '../../runtime/serial-queue.js'
import { type ConstraintKind, ConstraintViolation } from '../constraint-violation.js'
import { SET_PREVIOUS_CHANGES } from '../previous-changes.js'
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
import { mariaSql } from './mariadb-sql.js'
import { assertUnchanged, readMigrations } from './migrations.js'

/**
 * Server error codes for the constraints the stores distinguish, and where each message names the
 * constraint: "for key 'tags_name_key_unique'", "CONSTRAINT `nodes_path_check` failed".
 */
const CONSTRAINT_ERRORS: Readonly<Record<string, readonly [ConstraintKind, RegExp]>> = {
  ER_DUP_ENTRY: ['unique', /for key '(?:[^'.]+\.)?([^']+)'/],
  ER_NO_REFERENCED_ROW_2: ['foreign-key', /CONSTRAINT `([^`]+)`/],
  ER_ROW_IS_REFERENCED_2: ['foreign-key', /CONSTRAINT `([^`]+)`/],
  ER_CONSTRAINT_FAILED: ['check', /CONSTRAINT `([^`]+)`/],
}

const mariaConstraintViolation = (error: unknown): ConstraintViolation | null => {
  if (!(error instanceof SqlError) || error.code === null) return null
  const known = CONSTRAINT_ERRORS[error.code]
  if (known === undefined) return null
  const [kind, name] = known
  const constraint = name.exec(error.sqlMessage ?? error.message)?.[1] ?? null
  return new ConstraintViolation(kind, constraint, { cause: error })
}

/** Lock wait timeout and deadlock: the batch did not commit and can run again. */
const RETRYABLE_ERRNOS: readonly unknown[] = [1205, 1213]
const retryable = (error: unknown): boolean =>
  causes(error).some((cause) => 'errno' in cause && RETRYABLE_ERRNOS.includes(cause.errno))
const BATCH_ATTEMPTS = 5

/** One non-reconnecting session owns the runtime, serializes transactions, and holds GET_LOCK. */
export class MariaConnection implements TransactionalSqlConnection, StatementDriver<Connection> {
  readonly dialect = 'mariadb'
  private client: Promise<Connection> | undefined
  private readonly queue = serialQueue()
  private failure: Error | undefined
  private closing = false
  private onLost: ((error: Error) => void) | undefined
  constructor(readonly config: ConnectionConfig) {}
  private connect() {
    this.client ??= createConnection({
      connectTimeout: 10_000,
      queryTimeout: 30_000,
      bigIntAsNumber: true,
      decimalAsNumber: true,
      checkNumberRange: true,
      foundRows: false,
      logParam: false,
      autoJsonMap: false,
      charset: 'utf8mb4',
      collation: 'utf8mb4_nopad_bin',
      ...this.config,
    }).then(async (client) => {
      client.on('error', (error: Error) => {
        this.failure ??= error
        if (!this.closing) this.onLost?.(error)
      })
      await client.query(
        "SET SESSION sql_mode = 'ANSI_QUOTES,PIPES_AS_CONCAT,NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO'",
      )
      return client
    })
    return this.client
  }
  withClient<T>(operation: (client: Connection) => Promise<T>): Promise<T> {
    return this.queue(async () => {
      if (this.closing) throw new Error('Database is closing')
      if (this.failure) throw this.failure
      return operation(await this.connect())
    })
  }
  async execute(client: Connection, source: string, values: readonly unknown[]): Promise<Executed> {
    const { query, parameters, guarded } = mariaSql(source, values)
    try {
      if (guarded) await client.query('SET @caelestis_upsert_allowed = NULL')
      const result = await client.query<RowsWithMeta<unknown[]> | UpsertResult>(
        { sql: query, rowsAsArray: true },
        parameters,
      )
      if (!Array.isArray(result)) return { rows: [], columns: [], changes: result.affectedRows }
      if (guarded) {
        const [guard] = await client.query<{ allowed: number | null }[]>(
          'SELECT @caelestis_upsert_allowed AS allowed',
        )
        if (guard?.allowed === 0) return { rows: [], columns: [], changes: 0 }
      }
      return {
        rows: result,
        columns: result.meta.map((field) => field.name()),
        changes: /^INSERT\b/i.test(query) ? result.length : 0,
      }
    } catch (cause) {
      throw (
        mariaConstraintViolation(cause) ?? new Error(`MariaDB query failed: ${query}`, { cause })
      )
    }
  }
  async setPreviousChanges(client: Connection, changes: number): Promise<void> {
    await client.query(SET_PREVIOUS_CHANGES.mariadb, [changes])
  }
  async claimOwnership(onLost: (error: Error) => void) {
    if (this.onLost) throw new Error('Ownership already acquired')
    await this.withClient(async (client) => {
      const [row] = await client.query<{ acquired: number }[]>(
        "SELECT GET_LOCK(CONCAT('caelestis:', DATABASE()), 0) AS acquired",
      )
      if (row?.acquired !== 1) throw new Error('Another Caelestis server owns this database')
      this.onLost = onLost
    })
  }
  prepare(query: string): SqlStatement {
    return new DriverStatement(this, query)
  }
  async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transaction((connection) => connection.batch<T>(statements))
      } catch (error) {
        if (attempt >= BATCH_ATTEMPTS || !retryable(error)) throw error
      }
    }
  }
  transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      await client.beginTransaction()
      try {
        const result = await operation({
          dialect: this.dialect,
          prepare: (query) => new DriverStatement(this, query, [], client),
          batch: (statements) => runBatch(this, client, statements),
        })
        await client.commit()
        return result
      } catch (error) {
        await client.rollback()
        throw error
      }
    })
  }
  /** MariaDB DDL commits implicitly. Interrupted migrations fail closed until the backup is restored. */
  async migrate(directory: string) {
    await this.withClient(async (client) => {
      const [lock] = await client.query<{ acquired: number }[]>(
        "SELECT GET_LOCK(CONCAT('caelestis-migrations:', DATABASE()), 30) AS acquired",
      )
      if (lock?.acquired !== 1) throw new Error('Could not acquire migration lock')
      try {
        await client.query(
          'CREATE TABLE IF NOT EXISTS caelestis_migrations (name VARCHAR(256) PRIMARY KEY, sha256 VARCHAR(64) NOT NULL, complete BOOLEAN NOT NULL)',
        )
        for (const migration of readMigrations(directory)) {
          const { name, source, digest } = migration
          const [applied] = await client.query<{ sha256: string; complete: number }[]>(
            'SELECT sha256, complete FROM caelestis_migrations WHERE name = ?',
            [name],
          )
          if (applied) {
            assertUnchanged(migration, applied.sha256)
            if (!applied.complete)
              throw new Error(
                `Interrupted MariaDB migration ${name}; restore the pre-migration backup before restarting`,
              )
            continue
          }
          await client.query('INSERT INTO caelestis_migrations VALUES (?, ?, false)', [
            name,
            digest,
          ])
          const statements: string[] = []
          let start = 0
          const sql = source.replace(
            /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g,
            (token) => (token.startsWith('--') || token.startsWith('/*') ? '' : token),
          )
          for (const token of sql.matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"|;/g)) {
            if (token[0] !== ';') continue
            statements.push(sql.slice(start, token.index))
            start = token.index + 1
          }
          statements.push(sql.slice(start))
          for (const statement of statements.filter((query) => query.trim()))
            await client.query(statement)
          await client.query('UPDATE caelestis_migrations SET complete = true WHERE name = ?', [
            name,
          ])
        }
      } finally {
        await client.query("SELECT RELEASE_LOCK(CONCAT('caelestis-migrations:', DATABASE()))")
      }
    })
  }
  async close() {
    await this.queue(async () => undefined)
    this.closing = true
    if (this.client) await (await this.client).end()
  }
}
