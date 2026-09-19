import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sqliteConnection } from '../../node/database.js'
import { PostgresConnection, postgresParameters } from './postgres-connection.js'

it('preserves quoted markers and repeated numbered parameters', () => {
  expect(postgresParameters(`SELECT '?', "?", ?1, ?1, ?, 'it''s ?'`)).toBe(
    `SELECT '?', "?", $1, $1, $2, 'it''s ?'`,
  )
})

describe.skipIf(!process.env.CAELESTIS_TEST_POSTGRES_URL)('PostgreSQL persistence', () => {
  it('blocks preceding-binary inserts that overlap terminal claim retirement', async () => {
    const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`
    const connection = new PostgresConnection({
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    })
    await connection.pool.query(`CREATE SCHEMA ${schema}`)
    const retiring = await connection.pool.connect()
    const legacy = await connection.pool.connect()
    const insert = `INSERT INTO work_regions
      (id, season, surface_kind, claimant_user_id, claimant_name, x, y, w, h, label, created_at, expires_at)
      VALUES ('retired', 0, 'world', 1, 'Mia', 0, 0, 8, 8, '', 0, 0) ON CONFLICT(id) DO NOTHING`
    try {
      await connection.migrate(join(import.meta.dirname, '../../../migrations-postgres'))
      await legacy.query(insert)
      await retiring.query('BEGIN')
      await retiring.query("INSERT INTO work_region_deletions VALUES ('retired')")
      await retiring.query("DELETE FROM work_regions WHERE id = 'retired'")
      const { rows } = await legacy.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = rows[0]?.pid
      if (pid === undefined) throw new Error('missing legacy connection PID')
      const staleInsert = legacy.query(insert)
      await expect
        .poll(
          async () =>
            (
              await connection.pool.query<{ blocked: boolean }>(
                'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
                [pid],
              )
            ).rows[0]?.blocked,
        )
        .toBe(true)
      await retiring.query('COMMIT')
      expect((await staleInsert).rowCount).toBe(0)
      await legacy.query('DELETE FROM work_regions WHERE expires_at <= 1')
      expect((await legacy.query('SELECT * FROM work_regions')).rows).toEqual([])
      expect((await legacy.query('SELECT * FROM work_region_deletions')).rows).toEqual([
        { id: 'retired' },
      ])
    } finally {
      await retiring.query('ROLLBACK')
      retiring.release()
      legacy.release()
      await connection.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await connection.close()
    }
  })

  it('invalidates old public status caches once while retaining other coordinator state', async () => {
    const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`
    const connection = new PostgresConnection({
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    })
    const baseline = await mkdtemp(join(tmpdir(), 'caelestis-pg-baseline-'))
    const migrations = join(import.meta.dirname, '../../../migrations-postgres')
    await connection.pool.query(`CREATE SCHEMA ${schema}`)
    try {
      await copyFile(
        join(migrations, '0000_portable_baseline.sql'),
        join(baseline, '0000_portable_baseline.sql'),
      )
      await connection.migrate(baseline)
      await connection.pool.query(`
        CREATE TABLE runtime_values (actor TEXT, key TEXT, value TEXT, PRIMARY KEY(actor, key));
        INSERT INTO runtime_values VALUES
          ('season:0', 'status-read-model:v2:manifest', 'old'),
          ('season:0', 'status-read-model:v2:chunk:0', 'old'),
          ('season:0', 'manifest', 'keep'),
          ('counter:0', 'pending', 'keep');
      `)
      await connection.migrate(migrations)
      expect((await connection.pool.query('SELECT value FROM runtime_values')).rows).toEqual([
        { value: 'keep' },
        { value: 'keep' },
      ])
      await connection.pool.query(
        "INSERT INTO runtime_values VALUES ('season:0', 'status-read-model:v2:manifest', 'rebuilt')",
      )
      await connection.migrate(migrations)
      expect(
        (
          await connection.pool.query(
            "SELECT value FROM runtime_values WHERE key = 'status-read-model:v2:manifest'",
          )
        ).rows,
      ).toEqual([{ value: 'rebuilt' }])
    } finally {
      await connection.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await connection.close()
      await rm(baseline, { recursive: true, force: true })
    }
  })

  it('matches SQLite tables and columns, reruns migrations safely, and preserves committed data on reconnect', async () => {
    const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`
    const config = {
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    }
    const first = new PostgresConnection(config)
    const sqlite = sqliteConnection(':memory:')
    await first.pool.query(`CREATE SCHEMA ${schema}`)
    try {
      sqlite.migrate(join(import.meta.dirname, '../../../migrations'))
      await first.migrate(join(import.meta.dirname, '../../../migrations-postgres'))
      await first.migrate(join(import.meta.dirname, '../../../migrations-postgres'))
      const pgColumns = await first.pool.query<{
        table_name: string
        column_name: string
        data_type: string
      }>(
        'SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, column_name',
      )
      const tables = sqlite.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
      const sqliteColumns = tables
        .flatMap(({ name }) =>
          sqlite.sqlite
            .prepare(`PRAGMA table_info("${name}")`)
            .all()
            .map((column) => ({
              table_name: String(name),
              column_name: String(column.name),
              data_type:
                String(column.type).toLowerCase() === 'integer'
                  ? 'bigint'
                  : String(column.type).toLowerCase() === 'real'
                    ? 'double precision'
                    : String(column.type).toLowerCase(),
            })),
        )
        .sort((left, right) =>
          `${left.table_name}.${left.column_name}`.localeCompare(
            `${right.table_name}.${right.column_name}`,
            'en',
          ),
        )
      expect(
        pgColumns.rows.sort((left, right) =>
          `${left.table_name}.${left.column_name}`.localeCompare(
            `${right.table_name}.${right.column_name}`,
            'en',
          ),
        ),
      ).toEqual(sqliteColumns)
      await first.prepare("INSERT INTO server_settings (id, name) VALUES (1, 'Accepted')").run()
      await expect(
        first.batch([
          first.prepare("UPDATE server_settings SET name = 'Uncommitted' WHERE id = 1"),
          first.prepare('INSERT INTO server_settings (id) VALUES (1)'),
        ]),
      ).rejects.toThrow()
    } finally {
      sqlite.close()
      await first.close()
    }
    const second = new PostgresConnection(config)
    try {
      expect(await second.prepare('SELECT name FROM server_settings WHERE id = 1').first()).toEqual(
        { name: 'Accepted' },
      )
    } finally {
      await second.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await second.close()
    }
  })
})
