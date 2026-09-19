import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresConnection } from './postgres-connection.js'
import { claimSqliteOwnership } from './sqlite-ownership.js'

it('refuses a second SQLite owner and releases ownership when its process dies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-owner-'))
  const filename = join(directory, 'data.sqlite')
  const moduleUrl = new URL('./sqlite-ownership.ts', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { claimSqliteOwnership } from ${JSON.stringify(moduleUrl)};
      const release = claimSqliteOwnership(process.argv[1]);
      process.once('SIGTERM', () => { release(); process.exit(0) });
      process.stdout.write('ready'); setInterval(() => {}, 1000)`,
      filename,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('Owner process exited before acquiring its lock')
      }),
    ])
    expect(() => claimSqliteOwnership(filename)).toThrow('Another Caelestis server')
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    const release = claimSqliteOwnership(filename)
    release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(!process.env.CAELESTIS_TEST_POSTGRES_URL)(
  'fences a lost PostgreSQL connection and allows a replacement owner',
  async () => {
    const schema = `owner_${crypto.randomUUID().replaceAll('-', '')}`
    const config = {
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    }
    const first = new PostgresConnection(config)
    const second = new PostgresConnection(config)
    await first.pool.query(`CREATE SCHEMA ${schema}`)
    try {
      let reportLost: (error: Error) => void = () => {}
      const lost = new Promise<Error>((resolve) => {
        reportLost = resolve
      })
      await first.claimOwnership(reportLost)
      await expect(second.claimOwnership(() => {})).rejects.toThrow('Another Caelestis server')
      // Application queries run on pooled sessions now, so a pooled backend dying is not a loss of
      // ownership. Terminate the session that holds the ownership lock.
      const owner = await second.pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock'
         AND classid = hashtext('caelestis-runtime') AND objid = hashtext(current_schema())`,
      )
      expect(owner.rows).toHaveLength(1)
      await second.pool.query('SELECT pg_terminate_backend($1)', [owner.rows[0]?.pid])
      await lost
      await expect(first.prepare('SELECT 1').all()).rejects.toThrow()
      // The lost owner's sessions release their locks promptly; nothing of it lingers to block
      // a replacement.
      await vi.waitFor(
        async () => {
          const held = await second.pool.query<{ pid: number; mode: string }>(
            `SELECT pid, mode FROM pg_locks WHERE locktype = 'advisory' AND granted
             AND classid IN (hashtext('caelestis-runtime'), hashtext('caelestis-runtime-sessions'))`,
          )
          expect(held.rows).toEqual([])
        },
        { timeout: 3_000 },
      )
      await second.claimOwnership(() => {})
      expect(await second.prepare('SELECT 1 AS value').first()).toEqual({ value: 1 })
      await expect(first.prepare('SELECT 2').all()).rejects.toThrow()
    } finally {
      await second.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await first.close()
      await second.close()
    }
  },
  15_000,
)

it.skipIf(!process.env.CAELESTIS_TEST_POSTGRES_URL)(
  'runs owned application queries on several pooled sessions, each holding the session lock',
  async () => {
    const schema = `owner_${crypto.randomUUID().replaceAll('-', '')}`
    const config = {
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    }
    const owner = new PostgresConnection(config)
    await owner.pool.query(`CREATE SCHEMA ${schema}`)
    try {
      await owner.claimOwnership(() => {})
      // Hold each statement open briefly so the four cannot share one backend.
      const pids = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const row = await owner
            .prepare('SELECT pg_backend_pid() AS pid, pg_sleep(0.2) AS slept')
            .first<{ pid: number }>()
          return row?.pid
        }),
      )
      expect(new Set(pids).size).toBe(4)
      // Transactions take turns: four of them run on one backend, one after another.
      const transactionPids = await Promise.all(
        Array.from({ length: 4 }, () =>
          owner.transaction(async (connection) => {
            const row = await connection
              .prepare('SELECT pg_backend_pid() AS pid')
              .first<{ pid: number }>()
            return row?.pid
          }),
        ),
      )
      expect(new Set(transactionPids).size).toBe(1)
      // Batches on a tile table take turns in their own lane; other batches overlap.
      await owner.pool.query('CREATE TABLE tile_blob_reservations (id text)')
      const batchPids = async (query: string) =>
        Promise.all(
          Array.from({ length: 4 }, async () => {
            const [result] = await owner.batch<{ pid: number }>([owner.prepare(query)])
            return result?.results[0]?.pid
          }),
        )
      const tilePids = await batchPids(
        `SELECT pg_backend_pid() AS pid, pg_sleep(0.2) AS slept,
           (SELECT count(*) FROM tile_blob_reservations) AS reservations`,
      )
      expect(new Set(tilePids).size).toBe(1)
      const freePids = await batchPids('SELECT pg_backend_pid() AS pid, pg_sleep(0.2) AS slept')
      expect(new Set(freePids).size).toBe(4)
      const locks = await owner.pool.query<{ mode: string; count: string }>(
        `SELECT mode, count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory' AND granted AND classid = hashtext('caelestis-runtime-sessions')
         GROUP BY mode`,
      )
      expect(locks.rows).toEqual([{ mode: 'ShareLock', count: '4' }])
    } finally {
      await owner.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await owner.close()
    }
  },
)

it.skipIf(!process.env.CAELESTIS_TEST_POSTGRES_URL)(
  'refuses a new pooled session once the owner session is gone, even before the process notices',
  async () => {
    const schema = `owner_${crypto.randomUUID().replaceAll('-', '')}`
    const config = {
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    }
    const owner = new PostgresConnection(config)
    await owner.pool.query(`CREATE SCHEMA ${schema}`)
    let lost = 0
    try {
      await owner.claimOwnership(() => {
        lost++
      })
      // Pretend the process has not heard that its owner session died: swallow the event that
      // would end the pool, so the next query opens and fences a fresh session on its own.
      const session = (
        owner as unknown as {
          owner: {
            removeAllListeners(event: string): void
            on(event: string, listener: () => void): void
          }
        }
      ).owner
      session.removeAllListeners('error')
      session.on('error', () => {})
      await owner.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
         WHERE locktype = 'advisory' AND classid = hashtext('caelestis-runtime')::oid
           AND objid = hashtext(current_schema())::oid`,
      )
      await vi.waitFor(async () => {
        const held = await owner.pool.query(
          `SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory' AND classid = hashtext('caelestis-runtime')::oid`,
        )
        expect(held.rowCount).toBe(0)
      })
      await expect(owner.prepare('SELECT 1 AS one').first()).rejects.toThrow(
        'Another Caelestis server is taking over this database',
      )
      // The refusal is a lost ownership: the process is told and its pool ends, leaving no
      // shared lock behind for a replacement to wait on.
      expect(lost).toBe(1)
      await owner.close()
      const observer = new PostgresConnection(config)
      try {
        const shared = await observer.pool.query(
          `SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory' AND classid = hashtext('caelestis-runtime-sessions')::oid`,
        )
        expect(shared.rowCount).toBe(0)
      } finally {
        await observer.pool.query(`DROP SCHEMA ${schema} CASCADE`)
        await observer.close()
      }
    } finally {
      await owner.close()
    }
  },
)
