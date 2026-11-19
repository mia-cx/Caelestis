/**
 * The real backend app over memory adapters, for client contract suites in other packages.
 * Exported as `@caelestis/backend/testing`; importing the built package keeps the backend's own
 * compiler environment out of client test runners.
 */
import { type Millis, millis } from '@caelestis/shared'
import { MemoryBlobStore } from './adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from './adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from './adapters/memory/memory-sql-store.js'
import { type AppOptions, createApp } from './app.js'
import { hashToken, type Scope } from './auth/tokens.js'
import type { BackfillStorage } from './backfill/import.js'
import { makeBackendContext } from './runtime/backend-runtime.js'

export type { ArchiveSource } from './backfill/import.js'
export { TemplateBackfill } from './backfill/import.js'
export { type BackfillClients, localBackfillClient } from './backfill/port.js'

export interface TestBackendOptions extends AppOptions {
  /** Access tokens to seed, by secret. The first one is recorded as the creator of all of them. */
  readonly tokens?: Readonly<Record<string, Scope>>
  readonly clock?: () => Millis
}

export const createTestBackend = async ({
  tokens = {},
  clock,
  ...options
}: TestBackendOptions = {}) => {
  const sql = new MemorySqlStore()
  const blobs = new MemoryBlobStore()
  const counters = new MemoryCounterStore(sql, clock)
  const seeded = await Promise.all(
    Object.entries(tokens).map(async ([token, scope]) => ({
      tokenHash: await hashToken(token),
      scope,
    })),
  )
  for (const [index, { tokenHash, scope }] of seeded.entries()) {
    await sql.insertAccessToken({
      tokenHash,
      label: `Contract ${scope}`,
      scope,
      createdWithToken: seeded[0]?.tokenHash ?? tokenHash,
      createdAt: millis(index + 1),
    })
  }
  const app = createApp(makeBackendContext(blobs, sql, counters), {
    serverName: 'Test server',
    currentSeason: 3,
    ...options,
  })
  return { app, sql, blobs, counters }
}

/** Durable Object storage for a `TemplateBackfill` outside workerd. */
export class MemoryBackfillStorage implements BackfillStorage {
  readonly alarms: number[] = []
  private readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async list<T>(options: {
    prefix: string
    startAfter?: string
    limit?: number
  }): Promise<Map<string, T>> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(options.prefix))
        .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .slice(0, options.limit)
        .map(([key, value]) => [key, value as T]),
    )
  }

  async delete(keys: string[]): Promise<number> {
    return keys.filter((key) => this.values.delete(key)).length
  }

  async getAlarm(): Promise<number | null> {
    return this.alarms.at(-1) ?? null
  }

  async setAlarm(at: number): Promise<void> {
    this.alarms.push(at)
  }

  async deleteAlarm(): Promise<void> {
    this.alarms.length = 0
  }
}
