import { millis } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { exportPage, finishExport, startExport } from '../src/archive/export.js'
import {
  ArchiveOperationActiveError,
  closeProcessWrites,
  fencedConnection,
  openProcessWrites,
  readArchiveOperation,
  StaleArchiveOperationError,
} from '../src/archive/gate.js'
import type { ArchiveHost } from '../src/archive/port.js'
import { discardRestore } from '../src/archive/restore.js'
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

/** The gate row of a live operation, for coordinator tests that freeze on its behalf. */
const holdRow = (connection: SqlConnection, operationId: string) =>
  connection
    .prepare(
      'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, \'export\', ?, 0, 0, \'{"phase":"frozen"}\')',
    )
    .bind(operationId)
    .run()

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
    const draining = closeProcessWrites(connection, 'export-1').then(() => {
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
    // A late release of an older operation must not reopen writes this one closed.
    openProcessWrites(connection, 'export-0')
    await expect(fenced.prepare('UPDATE tags SET id = 2').run()).rejects.toBeInstanceOf(
      ArchiveOperationActiveError,
    )
    openProcessWrites(connection, 'export-1')
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
    await coordinator.freeze('restore-1')
    await coordinator.importCounterRows('restore-1', 'retained_counters', [retained])
    await coordinator.thaw('restore-1')
    await holdRow(opened.connection, 'export-1')
    await coordinator.freeze('export-1')
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
    // A late thaw for an older operation leaves this freeze in place.
    await restarted.thaw('export-0')
    await expect(restarted.record([delta as never])).rejects.toBeInstanceOf(
      ArchiveOperationActiveError,
    )
    await restarted.thaw('export-1')
    await open()
    expect(await restarted.exportCounterRows('retained_counters', null, 10)).toEqual([])

    // A freeze whose holder died before undoing it, with no operation left, clears itself.
    await restarted.freeze('crashed-resume')
    await opened.connection.prepare('DELETE FROM "archive_operation"').run()
    await restarted.record([delta as never])
  })

  it('waits for a flush admitted before the freeze, through its failure path', async () => {
    const opened = await relational()
    let entered: () => void = () => {}
    const flushing = new Promise<void>((resolve) => {
      entered = resolve
    })
    let fail: () => void = () => {}
    const failed = new Promise<void>((resolve) => {
      fail = resolve
    })
    /** Holds the bucket write so the flush is mid-flight when the freeze arrives. */
    class HeldFlush extends RelationalSqlStore {
      override async appendBuckets(): Promise<never> {
        entered()
        await failed
        throw new Error('bucket write failed after the freeze')
      }
    }
    const alarms: AlarmStorage = {
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    }
    const coordinator = new TelemetryCoordinator(
      coordinatorDatabase(opened.connection),
      alarms,
      new HeldFlush(opened.connection),
      () => millis(100_000),
    )
    await coordinator.initialize()
    const delta = { templateId: 'mural', occurredAt: 0, placed: 3, correct: 2, repairs: 1 }
    await coordinator.record([delta as never], 'delivery-1')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const flush = coordinator.alarm()
    await flushing
    await holdRow(opened.connection, 'export-1')
    let frozen = false
    const freezing = coordinator.freeze('export-1').then(() => {
      frozen = true
    })
    await settle()
    expect(frozen).toBe(false)
    fail()
    await flush
    await freezing
    const snapshot = async () =>
      Promise.all(
        (['pending_counters', 'flush_batch', 'flush_retry_state'] as const).map((table) =>
          coordinator.exportCounterRows(table, null, 10),
        ),
      )
    const archived = await snapshot()
    // The failure path already ran before freeze returned; a frozen alarm only re-arms.
    expect(archived[2]).toEqual([{ singleton: 1, consecutive_failures: 1 }])
    await coordinator.alarm()
    expect(await snapshot()).toEqual(archived)
    errors.mockRestore()
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

describe('archive operation lifecycle', () => {
  const coordinatorHost = async () => {
    const opened = await relational()
    const alarms: AlarmStorage = {
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    }
    const coordinator = new TelemetryCoordinator(
      coordinatorDatabase(opened.connection),
      alarms,
      opened.sql,
    )
    await coordinator.initialize()
    const visits = { count: 0 }
    let thawFailures = 0
    /** When set, the next freeze completes but its reply waits for this promise. */
    let delayNextFreeze: { readonly reply: Promise<void>; readonly frozen: () => void } | null =
      null
    const host: ArchiveHost = {
      ...archiveHost(opened.connection, visits),
      counters: {
        exportCounterRows: (...args) => coordinator.exportCounterRows(...args),
        importCounterRows: (...args) => coordinator.importCounterRows(...args),
        discardCounterRows: () => coordinator.discardCounterRows(),
        freeze: async (id) => {
          await coordinator.freeze(id)
          const delay = delayNextFreeze
          delayNextFreeze = null
          if (delay === null) return
          delay.frozen()
          await delay.reply
        },
        thaw: async (id) => {
          if (thawFailures > 0) {
            thawFailures -= 1
            throw new Error('thaw RPC failed')
          }
          await coordinator.thaw(id)
        },
      },
    }
    const delayFreeze = () => {
      let frozen: () => void = () => {}
      const reached = new Promise<void>((resolve) => {
        frozen = resolve
      })
      let reply: () => void = () => {}
      delayNextFreeze = {
        reply: new Promise<void>((resolve) => {
          reply = resolve
        }),
        frozen,
      }
      return { reached, reply }
    }
    return {
      host,
      coordinator,
      opened,
      failNextThaw: () => (thawFailures = 1),
      delayFreeze,
    }
  }
  const delta = { templateId: 'mural', occurredAt: 99, placed: 1, correct: 1, repairs: 0 }

  it('undoes a delayed freeze whose export was already finished', async () => {
    const { host, coordinator, opened, delayFreeze } = await coordinatorHost()
    const delayed = delayFreeze()
    const start = startExport(host)
    await delayed.reached
    expect(await finishExport(host)).toBe(true)
    delayed.reply()
    await expect(start).rejects.toThrow('Another request changed')
    // Nothing is left holding the server: relational writes and counters both work.
    expect(await readArchiveOperation(opened.connection)).toBeNull()
    expect(await opened.sql.archiveOperationActive({ fresh: true })).toBe(false)
    await coordinator.record([delta as never])
    await opened.sql.writeServerSettings({ name: 'Open again' })
    expect(await finishExport(host)).toBe(false)
  })

  it('keeps a release that failed to thaw retryable and the server held until it finishes', async () => {
    const { host, coordinator, opened, failNextThaw } = await coordinatorHost()
    await startExport(host)
    failNextThaw()
    await expect(finishExport(host)).rejects.toThrow('thaw RPC failed')
    // Still held, and visibly releasing rather than idle.
    expect(await readArchiveOperation(opened.connection)).toMatchObject({ kind: 'export' })
    expect(await opened.sql.archiveOperationActive({ fresh: true })).toBe(true)
    await expect(coordinator.record([delta as never])).rejects.toBeInstanceOf(
      ArchiveOperationActiveError,
    )
    expect(await finishExport(host)).toBe(true)
    expect(await readArchiveOperation(opened.connection)).toBeNull()
    await coordinator.record([delta as never])
  })

  it('lets the next start finish a release a crash left behind', async () => {
    const { host, opened, failNextThaw } = await coordinatorHost()
    await startExport(host)
    failNextThaw()
    await expect(finishExport(host)).rejects.toThrow('thaw RPC failed')
    const next = await startExport(host)
    expect(await readArchiveOperation(opened.connection)).toMatchObject({ operationId: next.id })
  })

  it('keeps a freeze whose row a stale read missed, refusing records until it thaws', async () => {
    const { coordinator, opened } = await coordinatorHost()
    await holdRow(opened.connection, 'export-1')
    await coordinator.freeze('export-1')
    // What a concurrent reader sees before this freeze's insert commits: an empty table. The
    // in-memory hold is the truth, so records stay refused.
    await opened.connection.prepare('DELETE FROM counter_freeze').run()
    await expect(coordinator.record([delta as never])).rejects.toBeInstanceOf(
      ArchiveOperationActiveError,
    )
  })

  it('keeps counters frozen through overlapping discards of one restore', async () => {
    const { host, coordinator, opened } = await coordinatorHost()
    await coordinator.freeze('restore-1')
    await opened.connection
      .prepare(
        'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, \'import\', \'restore-1\', 0, 0, ?)',
      )
      .bind(
        JSON.stringify({
          archiveId: 'archive-1',
          sourceServerId: 'source-1',
          tables: {},
          chain: '',
          counts: {},
          ended: false,
          phase: 'ready',
          preservedTokens: [],
        }),
      )
      .run()
    const [first, second] = await Promise.allSettled([discardRestore(host), discardRestore(host)])
    // Exactly one claim wins; the loser changed nothing, so neither thawed the hold.
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(
      JSON.parse((await readArchiveOperation(opened.connection))?.stateJson ?? '{}'),
    ).toMatchObject({ phase: 'discarding' })
    await expect(coordinator.record([delta as never])).rejects.toBeInstanceOf(
      ArchiveOperationActiveError,
    )
    // Records stay refused until the discard's release finishes.
    while (!(await discardRestore(host))) {
      /* one bounded step per call */
    }
    await coordinator.record([delta as never])
  })

  it('refuses counter rows for an operation whose freeze is gone, under a newer freeze', async () => {
    const { coordinator } = await coordinatorHost()
    await coordinator.freeze('new-op')
    const retained = {
      template_id: 'mural',
      bucket_start_s: 0,
      placed: 1,
      correct: 1,
      repairs: 0,
    }
    await expect(
      coordinator.importCounterRows('old-op', 'retained_counters', [retained]),
    ).rejects.toBeInstanceOf(StaleArchiveOperationError)
    expect(await coordinator.exportCounterRows('retained_counters', null, 10)).toEqual([])
  })

  it('finishes a freeze a crash interrupted before pages are read', async () => {
    const opened = await relational()
    const frozen: string[] = []
    const visits = { count: 0 }
    const base = archiveHost(opened.connection, visits)
    const host: ArchiveHost = {
      ...base,
      counters: { ...base.counters, freeze: async (id) => void frozen.push(id) },
    }
    // The row a process leaves when it dies between closing the gate and freezing counters.
    await opened.connection
      .prepare(
        'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, \'export\', \'crashed\', 0, 0, ?)',
      )
      .bind(JSON.stringify({ phase: 'freezing' }))
      .run()
    await exportPage(host, null)
    expect(frozen).toEqual(['crashed'])
    expect(JSON.parse((await readArchiveOperation(opened.connection))?.stateJson ?? '{}')).toEqual({
      phase: 'frozen',
    })
  })
})
