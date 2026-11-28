import { millis } from '@caelestis/shared'
import type { SqliteConnection } from '../../src/adapters/node/sqlite-connection.js'
import { createApp } from '../../src/app.js'
import { hashToken } from '../../src/auth/tokens.js'
import { openMemoryStores } from '../../src/node/memory-stores.js'
import type { SqlStore } from '../../src/ports/sql-store.js'
import { makeBackendContext } from '../../src/runtime/backend-runtime.js'
import type { StatusReadModelPort } from '../../src/status-read-model/port.js'

export const adminToken = 'ADMIN-TEST-TOKEN'

/** The app over the production stores on a private in-memory database. */
export const createTestBackend = async (
  options: {
    openAccess?: boolean
    bootstrapAdminToken?: string
    statusReadModel?: (sql: SqlStore) => StatusReadModelPort
    sql?: (connection: SqliteConnection) => SqlStore
  } = {},
) => {
  const stores = await openMemoryStores({ sql: options.sql })
  const { sql, blobs, counters } = stores
  const tokenHash = await hashToken(adminToken)
  await sql.insertAccessToken({
    tokenHash,
    label: 'test administrator',
    scope: 'admin',
    createdWithToken: tokenHash,
    createdAt: millis(1),
  })
  const app = createApp(makeBackendContext(blobs, sql, counters, options.statusReadModel?.(sql)), {
    server: {
      id: '00000000-0000-7000-8000-000000000000',
      name: 'Test server',
      auth: options.openAccess === true ? 'none' : 'access_token',
    },
    currentSeason: 3,
    bootstrapAdminToken: options.bootstrapAdminToken,
  })
  return { ...stores, app }
}

/**
 * A one-use event-runner invite as backend 1.6.0 minted it; nothing mints them now (#984). Returns
 * the invite's secret and hash.
 */
export const seedInvite = async (sql: SqlStore, label = 'event_runner') => {
  const token = `INVITE-${label}`
  const tokenHash = await hashToken(token)
  await sql.insertAccessToken({
    tokenHash,
    label,
    scope: 'event_runner',
    createdWithToken: await hashToken(adminToken),
    createdAt: millis(2),
    invite: true,
  })
  return { token, tokenHash }
}

/** `sql` with `onCall` run before every method call made through it, whatever the method. */
export const countCalls = (sql: SqlStore, onCall: () => void): SqlStore =>
  new Proxy(sql, {
    get: (target, key) => {
      const member: unknown = Reflect.get(target, key)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => {
        onCall()
        return Reflect.apply(member, target, args)
      }
    },
  })

export const authorized = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://backend.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${adminToken}`, ...init.headers },
  })
