import type { SqliteDatabase } from '../adapters/database-driver.js'
import type { NodeConfig } from './config.js'
import type { NodeRuntime } from './runtime.js'

interface BunModules {
  readonly listenBunServer: (
    runtime: NodeRuntime,
    config: NodeConfig,
  ) => Promise<{ port: number; close(): Promise<void> }>
  readonly bunSqliteDatabase: (filename: string) => SqliteDatabase
}

/**
 * Bun's server and SQLite driver when this process runs on Bun, otherwise undefined. URL imports
 * keep Bun's ambient types out of the Node and Cloudflare compilations.
 */
export const bun: BunModules | undefined = process.versions.bun
  ? {
      ...(await import(new URL('../bun/server.js', import.meta.url).href)),
      ...(await import(new URL('../bun/sqlite-driver.js', import.meta.url).href)),
    }
  : undefined
