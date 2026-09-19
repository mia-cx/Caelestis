import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient, type PoolConfig, types } from 'pg'
import { ingestTimings } from '../../telemetry/ingest-timing.js'
import type {
  SqlConnection,
  SqlResult,
  SqlStatement,
  TransactionalSqlConnection,
} from '../sql-connection.js'

/** Translate parameter markers while preserving quoted strings and identifiers verbatim. */
export const postgresParameters = (query: string): string => {
  let ordinal = 0
  return query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?\d*/g, (token) => {
    if (!token.startsWith('?')) return token
    const index = token.length === 1 ? ordinal + 1 : Number(token.slice(1))
    ordinal = Math.max(ordinal, index)
    return `$${index}`
  })
}

const integer = (value: string): number => {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new RangeError('Database integer exceeds the wire range')
  return number
}

const TRANSACTION_ATTEMPTS = 10
/**
 * Every table a tile commit reads or writes. Batches that touch any of them take turns.
 *
 * Rows alone do not decide conflicts under SERIALIZABLE: these tables are small, so the planner
 * scans them whole and a read locks the relation, and two overlapping transactions that each
 * read and write one of them abort each other however disjoint their rows are. A reservation and
 * a commit both read and write the reservation and object tables, so letting them overlap turned
 * every warmup burst into a retry storm inside the lane.
 */
const TILE_LANE_TABLES =
  /\b(canvas_tiles|status_read_model_revisions|template_alarm_tile_statuses|template_tile_measurements|template_tile_statuses|tile_blob_objects|tile_blob_reservations|tile_history)\b/
const laneFor = (statements: readonly SqlStatement[]): string | undefined =>
  statements.some(
    (statement) => statement instanceof Statement && TILE_LANE_TABLES.test(statement.query),
  )
    ? 'tiles'
    : undefined
const RETRY_LOG_LIMIT = 20
const retryable = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if ('code' in error && (error.code === '40001' || error.code === '40P01')) return true
  return error.cause === undefined ? false : retryable(error.cause)
}
/** The failing statement and the database's reason, for the first few retries in a log. */
const describeAbort = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const detail = error.cause instanceof Error ? describeAbort(error.cause) : ''
  const reason = 'detail' in error && typeof error.detail === 'string' ? ` (${error.detail})` : ''
  return `${error.message.replace(/\s+/g, ' ').slice(0, 300)}${reason}${detail ? `: ${detail}` : ''}`
}

class Statement implements SqlStatement {
  constructor(
    readonly owner: PostgresConnection,
    readonly query: string,
    readonly values: unknown[] = [],
    readonly client?: PoolClient,
  ) {}
  bind(...values: unknown[]): Statement {
    return new Statement(this.owner, this.query, values, this.client)
  }

  async execute(client: PoolClient) {
    const text = postgresParameters(this.query)
    const startedAt = performance.now()
    try {
      return await client.query<unknown[]>({ text, values: this.values, rowMode: 'array' })
    } catch (cause) {
      throw new Error(`PostgreSQL query failed: ${text}`, { cause })
    } finally {
      ingestTimings.record('sql', 'statement', performance.now() - startedAt)
    }
  }

  async run<T>(): Promise<SqlResult<T>> {
    const run = async (client: PoolClient): Promise<SqlResult<T>> => {
      const result = await this.execute(client)
      return {
        results: result.rows.map((row) =>
          Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
        ) as T[],
        meta: {
          changes: ['INSERT', 'UPDATE', 'DELETE'].includes(result.command)
            ? (result.rowCount ?? 0)
            : 0,
        },
      }
    }
    return this.client ? run(this.client) : this.owner.withClient(run)
  }
  all<T>(): Promise<SqlResult<T>> {
    return this.run<T>()
  }
  async first<T>(): Promise<T | null> {
    return (await this.run<T>()).results[0] ?? null
  }
  async raw<T>(): Promise<T[]> {
    const run = async (client: PoolClient) => (await this.execute(client)).rows as T[]
    return this.client ? run(this.client) : this.owner.withClient(run)
  }
}

const OWNERSHIP_LOCK = "hashtext('caelestis-runtime'), hashtext(current_schema())"
const SESSION_LOCK = "hashtext('caelestis-runtime-sessions'), hashtext(current_schema())"

/**
 * PostgreSQL/CNPG through a connection pool, fenced by two advisory locks.
 *
 * The owner session holds the ownership lock exclusively for the life of the process, as before.
 * Every pooled session that carries application work also holds a shared session lock. A
 * replacement owner takes the ownership lock once the old owner session is gone, then must
 * obtain the session lock exclusively before it serves, which the database only grants once every
 * session of the old process has closed. Losing the owner session ends this process's pool at
 * once, so no query of a former owner can commit after a replacement starts writing. Reads and
 * single statements run concurrently on the pool; transactions take turns, see `transaction`.
 */
export class PostgresConnection implements TransactionalSqlConnection {
  readonly dialect = 'postgres'
  readonly pool: Pool
  private owner: PoolClient | undefined
  /** The owner session's application name, unique per process, which fenced sessions verify. */
  private ownerName: string | undefined
  private ownerFailure: Error | undefined
  private lostOwnership: ((error: Error) => void) | undefined
  private readonly fenced = new WeakSet<PoolClient>()
  private readonly lanes = new Map<string, Promise<unknown>>()
  private retriesLogged = 0
  private closing = false
  private ended: Promise<void> | undefined

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      max: 10,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      ...config,
      types: {
        getTypeParser(oid, format) {
          if (format !== 'binary' && (oid === 20 || oid === 1700)) return integer
          return types.getTypeParser(oid, format)
        },
      },
    })
    // An idle pooled session can drop without affecting ownership; the pool discards it and the
    // next checkout opens and fences a new one. Without a listener the event would crash the
    // process.
    this.pool.on('error', (error) => {
      if (!this.closing) console.error('PostgreSQL pooled connection error', error)
    })
  }

  /** Hold the ownership lock on a dedicated session for the life of the process. */
  async claimOwnership(onLost: (error: Error) => void): Promise<void> {
    if (this.owner) throw new Error('Ownership already acquired')
    const client = await this.pool.connect()
    const lost = (error: Error) => {
      this.ownerFailure ??= error
      // Release every session lock now, so a replacement owner is not held up by a process that
      // has already lost ownership. In-flight queries fail with their connection, as before.
      // The dead owner client goes back to the pool as broken so draining does not wait on it.
      this.owner?.release(true)
      this.owner = undefined
      this.endPool()
      if (!this.closing) onLost(error)
    }
    client.on('error', lost)
    this.lostOwnership = lost
    try {
      const name = `caelestis-owner-${randomUUID()}`
      await client.query("SELECT set_config('application_name', $1, false)", [name])
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(${OWNERSHIP_LOCK}) AS acquired`,
      )
      if (!lock.rows[0]?.acquired) throw new Error('Another Caelestis server owns this database')
      this.ownerName = name
      // The previous owner's sessions may still be closing; wait for the last of them, bounded
      // by the statement timeout, then let this process's own sessions take shared locks.
      try {
        await client.query(`SELECT pg_advisory_lock(${SESSION_LOCK})`)
      } catch (cause) {
        throw new Error('A previous Caelestis server is still releasing this database', { cause })
      }
      await client.query(`SELECT pg_advisory_unlock(${SESSION_LOCK})`)
      this.owner = client
    } catch (error) {
      client.release(true)
      throw error
    }
  }

  /**
   * A pooled session may carry application work only while it holds the shared session lock and
   * this process's owner session still holds the ownership lock.
   *
   * The database releases the ownership lock the moment the owner backend dies, possibly before
   * this process hears of it. A replacement can then take ownership, drain the old sessions that
   * remain, and serve, while this process still believes it owns the database and opens a fresh
   * session, which the shared lock alone would admit. So a session checks, once it holds its
   * shared lock, that the ownership lock is held by a backend carrying this process's owner
   * name. A session that passes holds its shared lock for its lifetime, so no replacement can
   * drain past it; a session that fails ends this process's pool.
   */
  private async fence(client: PoolClient): Promise<void> {
    if (this.owner === undefined || this.fenced.has(client)) return
    const lock = await client.query<{ held: boolean }>(
      `SELECT pg_try_advisory_lock_shared(${SESSION_LOCK}) AS held`,
    )
    const owned = lock.rows[0]?.held
      ? await client.query<{ owned: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks AS lock
             INNER JOIN pg_stat_activity AS session ON session.pid = lock.pid
             WHERE lock.locktype = 'advisory' AND lock.granted AND lock.mode = 'ExclusiveLock'
               AND lock.classid = hashtext('caelestis-runtime')::oid
               AND lock.objid = hashtext(current_schema())::oid
               AND session.application_name = $1
           ) AS owned`,
          [this.ownerName],
        )
      : undefined
    if (!owned?.rows[0]?.owned) {
      const error = new Error('Another Caelestis server is taking over this database')
      this.ownerFailure ??= error
      this.lostOwnership?.(error)
      throw error
    }
    this.fenced.add(client)
  }

  private endPool(): Promise<void> {
    this.ended ??= this.pool.end().catch(() => undefined)
    return this.ended
  }

  /** Owned deployments never reconnect behind a lost ownership lock. */
  async withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const requestedAt = performance.now()
    if (this.closing) throw new Error('Database is closing')
    if (this.ownerFailure) throw this.ownerFailure
    const client = await this.pool.connect()
    ingestTimings.record('sql', 'poolWait', performance.now() - requestedAt)
    let broken = false
    try {
      await this.fence(client)
      if (this.ownerFailure) throw this.ownerFailure
      return await operation(client)
    } catch (error) {
      broken = this.ownerFailure !== undefined
      throw error
    } finally {
      client.release(broken)
    }
  }

  prepare(query: string): SqlStatement {
    return new Statement(this, query)
  }

  async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return this.inLane(laneFor(statements), () =>
      this.retrying(() => this.commitBatch<T>(statements)),
    )
  }

  /** Retry serialization failures with a short jittered backoff; the operation must be re-runnable. */
  private async retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run()
      } catch (error) {
        if (attempt === TRANSACTION_ATTEMPTS || !retryable(error)) throw error
        const backoff = Math.min(200, 5 * 2 ** (attempt - 1)) * (0.5 + Math.random())
        // One record per retry, so the count of this stage is the number of aborted attempts.
        ingestTimings.record('sql', 'retry', backoff)
        if (this.retriesLogged < RETRY_LOG_LIMIT) {
          this.retriesLogged++
          console.warn('PostgreSQL transaction retried', describeAbort(error))
        }
        await new Promise((resolve) => setTimeout(resolve, backoff))
      }
    }
  }

  /**
   * Transactions in the same lane take turns; transactions without a lane overlap freely.
   *
   * Overlapping SERIALIZABLE transactions that read and write the same small tables abort each
   * other, and a commit that exhausts its retries is answered to the client as unavailable.
   * Batches on the tile tables queue in one lane, as they effectively did on the single session;
   * the coordinator's callback transactions, on their own tables, queue in another. Everything
   * else, such as painters and telemetry, runs concurrently and the rare conflict is retried.
   */
  private inLane<T>(lane: string | undefined, run: () => Promise<T>): Promise<T> {
    if (lane === undefined) return run()
    const requestedAt = performance.now()
    const turn = () => {
      ingestTimings.record('sql', 'transaction', performance.now() - requestedAt)
      return run()
    }
    const tail = this.lanes.get(lane) ?? Promise.resolve()
    const running = tail.then(turn, turn)
    this.lanes.set(
      lane,
      running.then(
        () => undefined,
        () => undefined,
      ),
    )
    return running
  }

  private async executeBatch<T>(
    client: PoolClient,
    statements: SqlStatement[],
  ): Promise<SqlResult<T>[]> {
    const results: SqlResult<T>[] = []
    for (const statement of statements) {
      if (!(statement instanceof Statement) || statement.owner !== this)
        throw new Error('Statement belongs to another connection')
      if (statement.query.includes("current_setting('caelestis.changed_rows')")) {
        await client.query("SELECT set_config('caelestis.changed_rows', $1, true)", [
          String(results.at(-1)?.meta.changes ?? 0),
        ])
      }
      results.push(await new Statement(this, statement.query, statement.values, client).run<T>())
    }
    return results
  }

  /** A batch is its own transaction; its lane, if any, is chosen by `batch`, not shared with callbacks. */
  private commitBatch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return this.serializableTransaction((connection) => connection.batch<T>(statements))
  }

  /**
   * Run one serializable transaction.
   *
   * Reads and single statements share the pool. Transactions overlap unless they share a lane:
   * letting every transaction overlap made the ones that touch the same rows abort each other
   * under SERIALIZABLE, and a commit that exhausts its retries is answered to the client as
   * unavailable, which is the paint loss the ownership guard exists to prevent. Callback
   * transactions come from the coordinator's counter accounting and startup; their rows are
   * shared per template, so they take turns with each other and with nothing else. A
   * serialization failure is still retried, since a migration or maintenance job may run its
   * own transaction alongside.
   */
  async transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    return this.inLane('coordinator', () =>
      this.retrying(() => this.serializableTransaction(operation)),
    )
  }

  private async serializableTransaction<T>(
    operation: (connection: SqlConnection) => Promise<T>,
  ): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      try {
        const result = await operation({
          dialect: 'postgres',
          prepare: (query) => new Statement(this, query, [], client),
          batch: <R>(statements: SqlStatement[]) => this.executeBatch<R>(client, statements),
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
  }

  /** Serialize migration jobs and verify immutable SQL before applying pending migrations. */
  async migrate(directory: string): Promise<void> {
    await this.withClient(async (client) => {
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('caelestis-migrations'))")
        await client.query(
          'CREATE TABLE IF NOT EXISTS caelestis_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)',
        )
        for (const name of (await readdir(directory))
          .filter((name) => name.endsWith('.sql'))
          .sort()) {
          const source = await readFile(join(directory, name), 'utf8')
          const digest = createHash('sha256').update(source).digest('hex')
          const previous = await client.query<{ sha256: string }>(
            'SELECT sha256 FROM caelestis_migrations WHERE name = $1',
            [name],
          )
          if (previous.rows[0]) {
            if (previous.rows[0].sha256 !== digest)
              throw new Error(`Migration changed after application: ${name}`)
            continue
          }
          await client.query(source)
          await client.query('INSERT INTO caelestis_migrations VALUES ($1, $2)', [name, digest])
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
  }

  async close(): Promise<void> {
    this.closing = true
    this.owner?.release(true)
    await this.endPool()
  }
}
