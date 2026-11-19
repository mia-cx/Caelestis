import { millis } from '@caelestis/shared'
import type { SqliteConnection } from '../../src/adapters/node/sqlite-connection.js'
import type { RelationalSqlStore } from '../../src/adapters/relational-sql-store.js'
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
    sql?: (connection: SqliteConnection) => RelationalSqlStore
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
    serverId: '00000000-0000-7000-8000-000000000000',
    serverName: 'Test server',
    currentSeason: 3,
    openAccess: options.openAccess,
    bootstrapAdminToken: options.bootstrapAdminToken,
  })
  return { ...stores, app }
}

export const authorized = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://backend.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${adminToken}`, ...init.headers },
  })
