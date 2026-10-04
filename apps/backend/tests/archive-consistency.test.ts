import { millis } from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { RelationalSqlStore } from '../src/adapters/relational-sql-store.js'
import type {
  SqlConnection,
  SqlResult,
  SqlStatement,
  TransactionalSqlConnection,
} from '../src/adapters/sql-connection.js'
import { exportPage, startExport } from '../src/archive/export.js'
import {
  ArchiveOperationActiveError,
  closeProcessWrites,
  fencedConnection,
  openProcessWrites,
} from '../src/archive/gate.js'
import type { ArchiveHost } from '../src/archive/port.js'
import { type BackfillStorage, TemplateBackfill } from '../src/backfill/import.js'
import type { AlarmStorage } from '../src/coordination/database.js'
import { TelemetryCoordinator } from '../src/coordination/telemetry.js'
import { MemoryObjectStorage, runningImport } from './support/archive.js'
import { openRelationalStore } from './support/relational.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()))
})
const relational = async () => {
  const opened = await openRelationalStore()
  closes.push(opened.close)
  return opened
}
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

/** Every export page, with the backfill visits each page made. */
const exportAll = async (host: ArchiveHost, visits: { count: number }) => {
  await startExport(host)
  const pages: { lines: readonly string[]; visits: number }[] = []
  let cursor: string | null = null
  do {
    visits.count = 0
    const page = await exportPage(host, cursor)
    pages.push({ lines: page.lines, visits: visits.count })
    cursor = page.next
  } while (cursor !== null)
  return pages
}

const archiveHost = (connection: SqlConnection, visits: { count: number }): ArchiveHost => ({
  connection,
  objects: new MemoryObjectStorage(),
  counters: {
    exportCounterRows: async () => [],
    importCounterRows: async () => {},
    discardCounterRows: async () => {},
    freeze: async () => {},
    thaw: async () => {},
  },
  backfill: () => ({
    exportState: async () => {
      visits.count += 1
      return []
    },
    importState: async () => {},
    discardState: async () => true,
  }),
  serverId: '01890f3e-7b2c-7abc-8def-0000000000aa',
  activated: async () => {},
})

describe('archive snapshot boundary', () => {
  it('waits for writes admitted before the gate and refuses later ones at once', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    /** Every write waits for `held`, standing in for a slow transaction in another request. */
    class HeldStatement implements SqlStatement {
      bind(): SqlStatement {
        return this
      }
      async run<T>(): Promise<SqlResult<T>> {
        await held
        return { results: [], meta: { changes: 1 } }
      }
      async all<T>(): Promise<SqlResult<T>> {
        return { results: [], meta: { changes: 0 } }
      }
      async first<T>(): Promise<T | null> {
        return null
      }
      async raw<T>(): Promise<T[]> {
        return []
      }
    }
    const connection: TransactionalSqlConnection = {
      prepare: () => new HeldStatement(),
      batch: async () => [],
      transaction: (operation) => operation(connection),
    }
    const fenced = fencedConnection(connection)
    const admitted = fenced.prepare('INSERT INTO tags (id) VALUES (1)').run()
    let drained = false
    const draining = closeProcessWrites(connection).then(() => {
      drained = true
    })
    await settle()
    expect(drained).toBe(false)
    release()
    await admitted
    await draining
    await expect(fenced.prepare('UPDATE tags SET id = 2').run()).rejects.toBeInstanceOf(
      ArchiveOperationActiveError,
    )
    expect(await fenced.prepare('SELECT 1').first()).toBeNull()
    openProcessWrites(connection)
    expect(await fenced.prepare('UPDATE tags SET id = 2').run()).toMatchObject({
      meta: { changes: 1 },
    })
  })

  it('fails a D1 write inside its own batch once the gate row exists, whatever the cache says', async () => {
    const opened = await relational()
    // D1 has no in-process transactions; every write there carries the guard statement.
    const d1: SqlConnection = {
      dialect: 'sqlite',
      prepare: (query) => opened.connection.prepare(query),
      batch: (statements) => opened.connection.batch(statements),
    }
    const store = new RelationalSqlStore(d1)
    expect(await store.archiveOperationActive()).toBe(false)
    await opened.connection
      .prepare(
        'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, \'export\', \'x\', 0, 0, \'{}\')',
      )
      .run()
    await expect(store.writeServerSettings({ name: 'Too late' })).rejects.toMatchObject({
      cause: expect.any(ArchiveOperationActiveError),
    })
    expect((await opened.sql.readServerSettings()).name).toBeNull()
  })

  it('refuses counter records while frozen and keeps expired rows until it thaws', async () => {
    const opened = await relational()
    const alarms: AlarmStorage = {
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    }
    let now = millis(100_000)
    const open = async () => {
      const coordinator = new TelemetryCoordinator(
        coordinatorDatabase(opened.connection),
        alarms,
        opened.sql,
        () => now,
      )
      await coordinator.initialize()
      return coordinator
    }
    const coordinator = await open()
    const retained = { template_id: 'mural', bucket_start_s: 0, placed: 1, correct: 1, repairs: 0 }
    await coordinator.importCounterRows('retained_counters', [retained])
    await coordinator.freeze()
    const delta = { templateId: 'mural', occurredAt: 99, placed: 1, correct: 1, repairs: 0 }
    await expect(coordinator.record([delta as never])).rejects.toBeInstanceOf(
      ArchiveOperationActiveError,
    )

    // A restart long after the row's retention ends must not prune what the archive is reading.
    now = millis(100_000_000_000)
    const restarted = await open()
    expect(await restarted.exportCounterRows('retained_counters', null, 10)).toEqual([retained])
    await expect(restarted.record([delta as never])).rejects.toBeInstanceOf(
      ArchiveOperationActiveError,
    )
    await restarted.thaw()
    await open()
    expect(await restarted.exportCounterRows('retained_counters', null, 10)).toEqual([])
  })

  it('pauses an Eralyon import without changing the state an export reads', async () => {
    const values = new Map<string, unknown>([['job', runningImport('mural')]])
    const alarms: number[] = []
    const storage: BackfillStorage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key, value) => {
        values.set(key, value)
      },
      list: async <T>() => new Map([...values].map(([key, value]) => [key, value as T])),
      delete: async (keys) => keys.filter((key) => values.delete(key)).length,
      setAlarm: async (at) => {
        alarms.push(at)
      },
      deleteAlarm: async () => {},
    }
    // Only a fresh read sees the gate, as in the second after it closes on another isolate.
    class GateClosing extends MemorySqlStore {
      override async archiveOperationActive(options?: { readonly fresh?: boolean }) {
        return options?.fresh === true
      }
    }
    const importer = new TemplateBackfill(
      storage,
      new GateClosing(),
      new MemoryBlobStore(),
      { snapshots: async () => [], tile: async () => null },
      () => 5_000,
    )
    const before = await importer.exportState(null, 100)
    await importer.step()
    await importer.step()
    expect(await importer.exportState(null, 100)).toEqual(before)
    expect(alarms).toEqual([65_000, 65_000])

    await importer.importState(before)
    expect(alarms.at(-1)).toBe(5_100)
  })
})

describe('archive export budgets', () => {
  it('bounds pages by work when most templates never ran an import', async () => {
    const opened = await relational()
    const hash = 'a'.repeat(64)
    await opened.connection.batch(
      Array.from({ length: 1_100 }, (_, index) =>
        opened.connection
          .prepare(
            'INSERT INTO templates (id, season, name, created_with_token, created_at_ms, updated_at_ms) VALUES (?, 0, ?, ?, 1, 1)',
          )
          .bind(`template-${String(index).padStart(5, '0')}`, `Template ${index}`, hash),
      ),
    )
    const visits = { count: 0 }
    const pages = await exportAll(archiveHost(opened.connection, visits), visits)
    expect(pages.reduce((total, page) => total + page.visits, 0)).toBe(1_100)
    expect(Math.max(...pages.map((page) => page.visits))).toBeLessThanOrEqual(200)
  })

  it('measures rows before reading them, so large rows never overfill a page', async () => {
    const opened = await relational()
    const accounting = JSON.stringify({ note: 'x'.repeat(1_000_000) })
    await opened.connection.batch(
      Array.from({ length: 12 }, (_, index) =>
        opened.connection
          .prepare(
            'INSERT INTO applied_events (event_id, wplace_user_id, seen_at_ms, accounting_json) VALUES (?, 1, 1, ?)',
          )
          .bind(`event-${index}`, accounting),
      ),
    )
    const visits = { count: 0 }
    const pages = await exportAll(archiveHost(opened.connection, visits), visits)
    const pageBytes = pages.map((page) =>
      page.lines.reduce((total, line) => total + line.length, 0),
    )
    expect(Math.max(...pageBytes)).toBeLessThanOrEqual(8 * 1024 * 1024)
    const events = pages
      .flatMap((page) => page.lines)
      .filter((line) => line.startsWith('{"kind":"row","table":"applied_events"'))
    expect(events).toHaveLength(12)
    expect(new Set(events.map((line) => JSON.parse(line).values.event_id)).size).toBe(12)
  })
})
