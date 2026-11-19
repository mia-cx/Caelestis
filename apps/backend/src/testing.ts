/**
 * The real backend app over the production stores on a private in-memory database, for contract
 * suites. Exported as `@caelestis/backend/testing`; importing the built package keeps the backend's
 * own compiler environment out of client test runners.
 */
import { type Millis, millis, type Scope } from '@caelestis/shared'
import { createApp } from './app.js'
import { hashToken } from './auth/tokens.js'
import type { BackfillClients, BackfillStorage } from './backfill/port.js'
import { openMemoryStores } from './node/memory-stores.js'
import { makeBackendContext } from './runtime/backend-runtime.js'

export { TemplateBackfill } from './backfill/import.js'
export { type ArchiveSource, type BackfillClients, localBackfillClient } from './backfill/port.js'
export { openMemoryDatabase, seedTileObservation } from './node/memory-stores.js'

export interface TestBackendOptions {
  /** Access tokens to seed, by secret. The first one is recorded as the creator of all of them. */
  readonly tokens?: Readonly<Record<string, Scope>>
  readonly openAccess?: boolean
  readonly clock?: () => Millis
  readonly backfillClients?: BackfillClients
}

export const createTestBackend = async ({
  tokens = {},
  openAccess = false,
  clock,
  backfillClients,
}: TestBackendOptions = {}) => {
  const stores = await openMemoryStores({ clock })
  const { sql, blobs, counters } = stores
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
  const app = createApp(
    makeBackendContext(
      blobs,
      sql,
      counters,
      undefined,
      backfillClients === undefined ? {} : { backfill: backfillClients },
    ),
    {
      server: {
        id: '00000000-0000-7000-8000-000000000000',
        name: 'Test server',
        auth: openAccess ? 'none' : 'access_token',
      },
      currentSeason: 3,
    },
  )
  return { ...stores, app }
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
