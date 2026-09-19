import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqlDialect } from '../sql-dialect.js'
import { mariaTestDatabase } from './mariadb.test-helper.js'
import { MariaConnection } from './mariadb-connection.js'

describe.skipIf(!process.env.CAELESTIS_TEST_MARIADB_URL)('MariaDB connection', () => {
  let harness: Awaited<ReturnType<typeof mariaTestDatabase>>
  let db: MariaConnection
  beforeEach(async () => {
    harness = await mariaTestDatabase()
    db = harness.connection
    await db
      .prepare(
        'CREATE TABLE sample (id INTEGER PRIMARY KEY, value INTEGER NOT NULL CHECK (value >= 0))',
      )
      .run()
  })
  afterEach(async () => {
    await harness?.close()
  })

  it.each([false, true])(
    'guards legacy inserts at READ COMMITTED with fence=%s',
    async (fenced) => {
      const migrations = join(import.meta.dirname, '../../../migrations-mariadb')
      const directory = await mkdtemp(join(tmpdir(), 'caelestis-maria-fence-'))
      try {
        for (const name of await readdir(migrations)) {
          if (!fenced && name === '0006_region_deletion_fence.sql') continue
          await copyFile(join(migrations, name), join(directory, name))
        }
        await db.migrate(directory)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
      const legacy = new MariaConnection(harness.config)
      const insert = `INSERT INTO work_regions
      (id, season, surface_kind, claimant_user_id, claimant_name, x, y, w, h, label, created_at, expires_at)
      VALUES ('retired', 0, 'world', 1, 'Mia', 0, 0, 8, 8, '', 0, 0) ON CONFLICT(id) DO NOTHING`
      let staleInsert: Promise<boolean> | undefined
      try {
        await db.prepare(insert).run()
        await legacy.prepare('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED').run()
        const legacyId = await legacy
          .prepare('SELECT CONNECTION_ID() AS id')
          .first<{ id: number }>()
        const retired = await db.withClient(async (client) => {
          await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
          await client.beginTransaction()
          try {
            // INSERT ... SELECT in the deletion batch reads the live row before retiring its ID.
            await client.query("SELECT id FROM work_regions WHERE id = 'retired' FOR UPDATE")
            staleInsert = legacy
              .prepare(insert)
              .run()
              .then(
                () => true,
                () => false,
              )
            await expect
              .poll(
                async () =>
                  (
                    await harness.admin
                      .prepare(`
            SELECT count(*) AS waiting FROM information_schema.INNODB_LOCK_WAITS w
            JOIN information_schema.INNODB_TRX t ON t.trx_id = w.requesting_trx_id
            WHERE t.trx_mysql_thread_id = ?`)
                      .bind(legacyId?.id)
                      .first<{ waiting: number }>()
                  )?.waiting,
                { timeout: 5000 },
              )
              .toBe(1)
            await client.query("INSERT INTO work_region_deletions VALUES ('retired')")
            await client.query("DELETE FROM work_regions WHERE id = 'retired'")
            await client.commit()
            return true
          } catch (error) {
            await client.rollback()
            if (error instanceof Error && 'errno' in error && error.errno === 1213) return false
            throw error
          }
        })
        await staleInsert
        // Either lock ordering can lose a deadlock. The production batch retries retirement.
        if (!retired)
          await db.batch([
            db.prepare(
              "INSERT INTO work_region_deletions VALUES ('retired') ON CONFLICT(id) DO NOTHING",
            ),
            db.prepare("DELETE FROM work_regions WHERE id = 'retired'"),
          ])
        // The unfenced control must reproduce the resurrection, or this interleaving proves nothing.
        expect((await db.prepare('SELECT id FROM work_regions').all()).results).toEqual(
          fenced ? [] : [{ id: 'retired' }],
        )
        expect((await db.prepare('SELECT * FROM work_region_deletions').all()).results).toEqual([
          { id: 'retired' },
        ])
      } finally {
        await legacy.close()
      }
    },
  )

  it('repeats numbered parameters and preserves literals without SQL interpolation', async () => {
    const value = "?2 ' \\ ON CONFLICT §0§"
    expect(
      await db
        .prepare("SELECT ?2 AS second, ?1 AS first, ?2 AS again, '?1' AS literal")
        .bind(42, value)
        .first(),
    ).toEqual({ second: value, first: 42, again: value, literal: '?1' })
  })
  it('ignores only duplicate keys, preserving validation failures and change counts', async () => {
    const statement = 'INSERT INTO sample (id, value) VALUES (?, ?) ON CONFLICT(id) DO NOTHING'
    expect((await db.prepare(statement).bind(1, 2).run()).meta.changes).toBe(1)
    expect((await db.prepare(statement).bind(1, 4).run()).meta.changes).toBe(0)
    await expect(db.prepare(statement).bind(2, -1).run()).rejects.toThrow()
    expect(await db.prepare('SELECT * FROM sample').all()).toMatchObject({
      results: [{ id: 1, value: 2 }],
    })
  })
  it('preserves JSON strings, nulls, Unicode lengths, and safe integer boundaries', async () => {
    const syntax = sqlDialect('mariadb')
    const query = `SELECT ${syntax.jsonField('text', 'text')} AS text, ${syntax.jsonField('missing', 'text')} AS missing FROM ${syntax.jsonEach}`
    expect(
      (
        await db
          .prepare(query)
          .bind(JSON.stringify([{ text: 'null', missing: null }, { text: '🦊' }]))
          .all()
      ).results,
    ).toEqual([
      { text: 'null', missing: null },
      { text: '🦊', missing: null },
    ])
    expect(await db.prepare('SELECT length(?1) AS size').bind('🦊').first()).toEqual({ size: 1 })
    await expect(
      db.prepare('SELECT CAST(9007199254740993 AS SIGNED) AS value').first(),
    ).rejects.toThrow()
  })
  it('applies conditional updates using the old row and omits rejected RETURNING rows', async () => {
    const statement =
      'INSERT INTO sample (id, value) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET value = excluded.value WHERE sample.value < excluded.value RETURNING id, value'
    expect(await db.prepare(statement).bind(1, 4).first()).toEqual({ id: 1, value: 4 })
    expect(await db.prepare(statement).bind(1, 2).first()).toBeNull()
    expect(await db.prepare(statement).bind(1, 6).first()).toEqual({ id: 1, value: 6 })
  })
  it('rolls back a failed batch and a failed asynchronous transaction', async () => {
    await expect(
      db.batch([
        db.prepare('INSERT INTO sample VALUES (1, 1)'),
        db.prepare('INSERT INTO sample VALUES (2, -1)'),
      ]),
    ).rejects.toThrow()
    await expect(
      db.transaction(async (tx) => {
        await tx.prepare('INSERT INTO sample VALUES (3, 1)').run()
        throw new Error('cancel')
      }),
    ).rejects.toThrow('cancel')
    expect((await db.prepare('SELECT * FROM sample').all()).results).toEqual([])
  })
  it('fences a disconnected owner and permits a replacement', async () => {
    const rival = new MariaConnection(harness.config)
    try {
      let reportLost: (error: Error) => void = () => {}
      const lost = new Promise<Error>((resolve) => {
        reportLost = resolve
      })
      await db.claimOwnership(reportLost)
      await expect(rival.claimOwnership(() => {})).rejects.toThrow('Another Caelestis')
      const row = await db.prepare('SELECT CONNECTION_ID() AS id').first<{ id: number }>()
      await harness.admin.prepare(`KILL CONNECTION ${row?.id}`).run()
      await lost
      await expect(db.prepare('SELECT 1').run()).rejects.toThrow()
      await rival.claimOwnership(() => {})
    } finally {
      await rival.close()
    }
  })
  it('verifies migration checksums and refuses interrupted DDL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caelestis-maria-migrations-'))
    try {
      await writeFile(
        join(directory, '0000.sql'),
        "-- a comment; with a semicolon\nCREATE TABLE migrated (id INTEGER, value TEXT); INSERT INTO migrated VALUES (1, 'one;--two');",
      )
      await db.migrate(directory)
      await db.migrate(directory)
      expect(await db.prepare('SELECT * FROM migrated').first()).toEqual({
        id: 1,
        value: 'one;--two',
      })
      await writeFile(join(directory, '0000.sql'), 'CREATE TABLE changed (id INTEGER);')
      await expect(db.migrate(directory)).rejects.toThrow('Migration changed')
      await db.prepare('DELETE FROM caelestis_migrations').run()
      await writeFile(
        join(directory, '0000.sql'),
        'CREATE TABLE partial (id INTEGER); INVALID SQL;',
      )
      await expect(db.migrate(directory)).rejects.toThrow()
      await expect(db.migrate(directory)).rejects.toThrow('Interrupted MariaDB migration')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
