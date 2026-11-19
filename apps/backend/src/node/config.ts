import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { ConnectionConfig } from 'mariadb'
import type { PoolConfig } from 'pg'
import { parseServerConfig } from '../server/config.js'

type Environment = Readonly<Record<string, string | undefined>>
const integer = (env: Environment, name: string, fallback: number): number => {
  const value = env[name] || undefined
  if (value === undefined) return fallback
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a non-negative integer`)
  return Number(value)
}

// `../../package.json` resolves to apps/backend/package.json from both `src/node/` and `dist/node/`.
const backendVersion = (
  createRequire(import.meta.url)('../../package.json') as { version?: string }
).version

/** Where the backend answers when BASE_PATH is unset; the frontend owns the root. */
export const LEGACY_MOUNT = '/backend'

/** Validate the portable deployment configuration before opening storage or accepting traffic. */
export const readNodeConfig = (env: Environment = process.env) => {
  const server = parseServerConfig(env, {
    version: backendVersion,
    build: env.CAELESTIS_BUILD_ID,
  })
  if (server.adminToken !== undefined && server.adminToken === env.CAELESTIS_READ_TOKEN)
    throw new Error('ADMIN_TOKEN and CAELESTIS_READ_TOKEN must be different credentials')
  if (integer(env, 'REPLICAS', 1) !== 1)
    throw new Error('Only one active application replica is supported')
  if (env.BASE_PATH === '/')
    throw new Error('BASE_PATH must not be the root: the frontend serves it')
  const adapter = env.DB_ADAPTER ?? 'sqlite'
  if (adapter !== 'sqlite' && adapter !== 'postgres' && adapter !== 'mariadb')
    throw new Error(`Unsupported DB_ADAPTER: ${adapter}`)
  const port = integer(env, 'PORT', 3000)
  if (port > 65535) throw new Error('PORT must be at most 65535')
  const tlsMode = env.PG_TLS_MODE ?? 'verify-full'
  if (!['verify-full', 'require', 'disable'].includes(tlsMode))
    throw new Error('Unsupported PG_TLS_MODE')
  if (
    env.DATABASE_URL &&
    [...new URL(env.DATABASE_URL).searchParams.keys()].some((key) => key.startsWith('ssl'))
  )
    throw new Error(
      'Configure PostgreSQL TLS through PG_TLS_MODE and PG_TLS_CA_FILE, not DATABASE_URL parameters',
    )
  if (adapter === 'postgres' && !env.DATABASE_URL && !env.PGHOST)
    throw new Error('PostgreSQL requires DATABASE_URL or PGHOST')
  const pg: PoolConfig = {
    ...(env.PGHOST ? { host: env.PGHOST } : {}),
    ...(env.PGPORT ? { port: integer(env, 'PGPORT', 5432) } : {}),
    ...(env.PGDATABASE ? { database: env.PGDATABASE } : {}),
    ...(env.PGUSER ? { user: env.PGUSER } : {}),
    ...(env.PGPASSWORD ? { password: env.PGPASSWORD } : {}),
    ...(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {}),
    ssl:
      tlsMode === 'disable'
        ? false
        : {
            rejectUnauthorized: tlsMode === 'verify-full',
            ...(env.PG_TLS_CA_FILE ? { ca: readFileSync(env.PG_TLS_CA_FILE, 'utf8') } : {}),
            ...(env.PG_TLS_CERT_FILE ? { cert: readFileSync(env.PG_TLS_CERT_FILE, 'utf8') } : {}),
            ...(env.PG_TLS_KEY_FILE ? { key: readFileSync(env.PG_TLS_KEY_FILE, 'utf8') } : {}),
          },
  }
  const mariaTls = env.MARIADB_TLS_MODE ?? 'verify-full'
  if (!['verify-full', 'require', 'disable'].includes(mariaTls))
    throw new Error('Unsupported MARIADB_TLS_MODE')
  if (adapter === 'mariadb' && (!env.MARIADB_HOST || !env.MARIADB_DATABASE || !env.MARIADB_USER))
    throw new Error('MariaDB requires MARIADB_HOST, MARIADB_DATABASE, and MARIADB_USER')
  const maria: ConnectionConfig = {
    ...(env.MARIADB_HOST ? { host: env.MARIADB_HOST } : {}),
    port: integer(env, 'MARIADB_PORT', 3306),
    ...(env.MARIADB_DATABASE ? { database: env.MARIADB_DATABASE } : {}),
    ...(env.MARIADB_USER ? { user: env.MARIADB_USER } : {}),
    ...(env.MARIADB_PASSWORD ? { password: env.MARIADB_PASSWORD } : {}),
    ssl:
      mariaTls === 'disable'
        ? false
        : {
            rejectUnauthorized: mariaTls === 'verify-full',
            ...(env.MARIADB_TLS_CA_FILE
              ? { ca: readFileSync(env.MARIADB_TLS_CA_FILE, 'utf8') }
              : {}),
            ...(env.MARIADB_TLS_CERT_FILE
              ? { cert: readFileSync(env.MARIADB_TLS_CERT_FILE, 'utf8') }
              : {}),
            ...(env.MARIADB_TLS_KEY_FILE
              ? { key: readFileSync(env.MARIADB_TLS_KEY_FILE, 'utf8') }
              : {}),
          },
  }
  return {
    ...server,
    /** The backend's mount on this listener; the legacy mount answers too. */
    basePath: server.basePath ?? LEGACY_MOUNT,
    adapter,
    port,
    pg,
    maria,
    host: env.HOST ?? '0.0.0.0',
    databaseFile: env.SQLITE_FILE ?? resolve(env.DATA_DIRECTORY ?? './data', 'caelestis.sqlite'),
    readToken: env.CAELESTIS_READ_TOKEN,
    /** A module whose `handler` serves the frontend on the same listener. */
    frontendHandler: env.FRONTEND_HANDLER,
    /** The object-storage backend `nodeObjectStorage` picks, for the startup log. */
    objectStorage: env.OBJECT_STORAGE ?? 'filesystem',
  } as const
}

export type NodeConfig = ReturnType<typeof readNodeConfig>
