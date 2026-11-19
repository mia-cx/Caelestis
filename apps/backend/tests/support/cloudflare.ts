import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { ARCHIVE_ADMIN, type Fetch } from './archive.js'

const here = dirname(fileURLToPath(import.meta.url))
const NO_BODY = new Set([101, 204, 205, 304])

/** The production Worker as one module, built once per test file. */
export const bundleWorker = async (): Promise<string> => {
  const bundled = await build({
    entryPoints: [join(here, '../../src/worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:workers', 'node:*'],
    define: {
      __CAELESTIS_DEPLOYMENT_VERSION__: '"test"',
      __CAELESTIS_BACKEND_VERSION__: '"test"',
      __CAELESTIS_USERSCRIPT_VERSIONS__: '[]',
    },
    write: false,
  })
  return bundled.outputFiles[0]?.text ?? ''
}

/**
 * The production Worker with real local D1, R2, and Durable Objects. `outbound` answers the
 * Worker's own requests to other origins, such as the Eralyon archive. `vars`, when given,
 * replaces the test deployment's variables.
 */
export const openCloudflare = async (
  worker: string,
  outbound?: (request: Request) => Response | Promise<Response>,
  vars?: Readonly<Record<string, string>>,
) => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: worker,
      compatibilityDate: '2026-08-03',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      r2Buckets: ['BLOBS'],
      durableObjects: {
        TELEMETRY: { className: 'TelemetryShard', useSQLite: true },
        ALARM_WATCHER: { className: 'AlarmWatcher', useSQLite: true },
        STATUS_READ_MODEL: { className: 'StatusReadModelObject', useSQLite: true },
        TEMPLATE_BACKFILL: { className: 'TemplateBackfillObject', useSQLite: true },
        PRESENCE: { className: 'PresenceObject', useSQLite: true },
      },
      bindings: vars ?? {
        SHARD_STRATEGY: 'single',
        SERVER_ID: '01890f3e-7b2c-7abc-8def-0000000000aa',
        SERVER_NAME: 'Caelestis',
        SEASON: '0',
        ADMIN_TOKEN: ARCHIVE_ADMIN,
        ARCHIVE_SETTLE_SECONDS: '0',
      },
      ...(outbound === undefined ? {} : { outboundService: outbound }),
    }),
  )
  const database = await runtime.getD1Database('DB')
  const migrations = join(here, '../../migrations')
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort())
    for (const statement of (await readFile(join(migrations, file), 'utf8')).split(
      '--> statement-breakpoint',
    ))
      if (statement.trim()) await database.prepare(statement).run()
  const fetch: Fetch = async (input, init) => {
    // Miniflare bundles its own undici, which cannot read Node's FormData. Serialize first.
    const request = new Request(input, init)
    const response = await runtime.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(request.body === null ? {} : { body: new Uint8Array(await request.arrayBuffer()) }),
    })
    return new Response(NO_BODY.has(response.status) ? null : await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    })
  }
  return {
    fetch,
    /** Miniflare's own fetch, which keeps a WebSocket upgrade's socket. */
    dispatchFetch: runtime.dispatchFetch.bind(runtime),
    api: 'https://cloudflare.test/v1',
    database,
    dispose: () => runtime.dispose(),
  }
}
