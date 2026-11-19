import type { Scope, ServerInfo } from '@caelestis/shared'
import { isUuidV7, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from '@caelestis/shared'
import { Context as Services } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ArchiveHost } from './archive/port.js'
import { requireScopeEffect } from './auth/middleware.js'
import type { BackfillClients } from './backfill/port.js'
import type { ConnectPresence, PresenceOnline } from './presence/port.js'
import { archiveHold, createArchiveAdminRoutes } from './routes/archive.js'
import { createBackfillAdminRoutes, createCanvasHistoryRoutes } from './routes/backfill.js'
import { createManifestRoutes } from './routes/manifest.js'
import { createNodeRoutes } from './routes/nodes.js'
import {
  createServerAdminRoutes,
  createServerAssetRoutes,
  createServerRoutes,
} from './routes/server.js'
import { createTagRoutes } from './routes/tags.js'
import { createTelemetryRoutes } from './routes/telemetry.js'
import { createBlobRoutes, createRecipeRoutes, createTemplateRoutes } from './routes/templates.js'
import { createTokenRoutes } from './routes/tokens.js'
import { createWorkRoutes } from './routes/work.js'
import {
  type BackendContext,
  createBackendRuntime,
  SqlStoreService,
  StatusReadModelService,
} from './runtime/backend-runtime.js'
import { errorResponse } from './runtime/hono.js'

/**
 * The Hono app, deliberately free of any runtime binding.
 *
 * Entry points adapt this app to a runtime; the app itself stays portable and only depends on the
 * use-case-shaped ports.
 *
 * @see https://github.com/mia-cx/Caelestis/issues/12
 */
export interface AppOptions {
  /** Relational runtimes can export and restore complete server archives. */
  readonly archive?: ArchiveHost
  readonly connectPresence?: ConnectPresence
  readonly presenceOnline?: PresenceOnline
  readonly backfillClients?: BackfillClients
  /**
   * The operator's bootstrap credential. Absent means the server has no bootstrap path, which is
   * the right state once a real admin token has been minted.
   */
  readonly bootstrapAdminToken?: string | undefined
  readonly serverId?: string | undefined
  readonly serverName?: string | undefined
  readonly serverDescription?: string | undefined
  /** Backend package version reported on `/server`. */
  readonly version?: string | undefined
  /** Deploy/build identifier reported on `/server`, e.g. the first 12 characters of the release SHA. */
  readonly build?: string | undefined
  readonly openAccess?: boolean | undefined
  readonly currentSeason?: number | undefined
  readonly connectStatusLive?:
    | ((
        request: Request,
        connection: {
          readonly season: number
          readonly scope: 'public' | 'admin'
          readonly credentialScope: Scope
          readonly tokenHash: string
          readonly clientHash: string
          readonly anonymous: boolean
          readonly revocable: boolean
          readonly lastRevision: number | null
          readonly metricClient: string
          readonly metricClientVersion: string
          readonly protocol: 1 | 2
        },
      ) => Promise<Response>)
    | undefined
}

export const createApp = (context: BackendContext, options: AppOptions = {}) => {
  const app = new Hono()
  const runtime = createBackendRuntime(context)
  const auth = {
    bootstrapAdminToken: options.bootstrapAdminToken,
    openAccess: options.openAccess,
  }
  const bootstrapConfigured =
    options.bootstrapAdminToken !== undefined && options.bootstrapAdminToken.length > 0
  // `??` guards `undefined` and nothing else, and every one of these is a wrangler.toml var an
  // operator edits by hand. A non-UUIDv7 id, an empty name or an empty description all passed
  // through and then failed the wire schema — so the deployment's own manifest became undecodable
  // and the operator heard about it from a client, if at all. Refuse at startup instead.
  const configured = <T>(value: T, valid: (value: T) => boolean, name: string): T => {
    if (!valid(value)) throw new Error(`${name} is not valid: ${JSON.stringify(value)}`)
    return value
  }
  const serverBase = {
    id: configured(
      options.serverId ?? '00000000-0000-7000-8000-000000000000',
      isUuidV7,
      'serverId',
    ),
    name: configured(
      options.serverName ?? 'Template Server',
      (name) => name.length > 0 && name.length <= MAX_NAME_LENGTH,
      'serverName',
    ),
    auth: options.openAccess === true ? 'none' : 'access_token',
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(options.connectPresence === undefined ? {} : { presence: 1 as const }),
    ...(options.connectStatusLive === undefined
      ? {}
      : {
          liveSync: 1 as const,
          liveSyncMax: 2 as const,
          liveTileOffers: 1 as const,
          livePaintParts: 1 as const,
        }),
  } as const
  const server: ServerInfo =
    options.serverDescription === undefined
      ? serverBase
      : {
          ...serverBase,
          description: configured(
            options.serverDescription,
            (description) => description.length > 0 && description.length <= MAX_DESCRIPTION_LENGTH,
            'serverDescription',
          ),
        }
  const currentSeason = options.currentSeason ?? 0

  // The userscript runs on wplace.live and calls this server cross-origin.
  // `ETag` has to be named explicitly. It is not a CORS-safelisted response header, and Hono only
  // emits `Access-Control-Expose-Headers` when `exposeHeaders` is non-empty — so the userscript,
  // which is cross-origin by definition, read `null` from `response.headers.get('etag')` and could
  // never build an `If-None-Match`. The whole 304 path was unreachable for the only client it
  // exists for, which is also what `assembleManifest` goes to the trouble of being deterministic
  // for. `/chunks` was unaffected: it signals with `Cache-Control`, which is safelisted.
  // Every request it makes carries an `Authorization` header, which is not a CORS-simple header, so
  // *each one* is preceded by an `OPTIONS` preflight — and the default `maxAge` is unset, meaning
  // the browser may not reuse the answer at all. That is what fills the log with 204s: one per
  // manifest poll, one per chunk, one per admin action. The answer cannot vary here — the policy is
  // a constant, not derived from the request — so caching it is free. Browsers clamp this hard
  // (Chromium at 2 hours, Safari at 10 minutes), which is why the number is a ceiling to be ignored
  // rather than a promise to be kept.
  app.use('/*', cors({ origin: '*', exposeHeaders: ['ETag'], maxAge: 86_400 }))

  app.onError((error, c) => errorResponse(c, error))
  app.get('/health', (c) => c.json({ ok: true }))

  const admin = requireScopeEffect(runtime, auth, 'admin')
  const read = requireScopeEffect(runtime, auth, 'read')
  // Restored manifests replace whatever was cached while the server was empty; live clients
  // reconnect into the restored revisions, which continue from the source's.
  const host = options.archive
  const archiveHost: ArchiveHost | undefined =
    host === undefined
      ? undefined
      : {
          ...host,
          activated: async () => {
            await host.activated()
            await Services.get(context, StatusReadModelService).notifyManifestChange?.(
              currentSeason,
            )
          },
        }

  // Answers while an archive operation holds the server: identity, and the archive itself.
  const open = new Hono()
  open.route('/server', createServerRoutes(runtime, server))
  open.use('/admin/archive/*', admin)
  open.route('/admin/archive', createArchiveAdminRoutes(archiveHost))

  // Everything else waits out an archive operation. Scope is declared per mount; a route that
  // needs more than its mount, such as a `report` write under `read`, says so itself.
  const gated = new Hono()
  gated.use('/*', archiveHold(Services.get(context, SqlStoreService)))
  gated.use('/admin/*', admin)
  for (const mount of [
    '/manifest',
    '/work',
    '/archive',
    '/chunks',
    '/sources',
    '/recipes',
    '/tiles',
  ])
    gated.use(`${mount}/*`, read)
  gated.route('/server/assets', createServerAssetRoutes(runtime))
  gated.route('/admin/server', createServerAdminRoutes(runtime, currentSeason))
  gated.route('/admin/tokens', createTokenRoutes(runtime, { currentSeason, bootstrapConfigured }))
  gated.route('/admin/backfill', createBackfillAdminRoutes(options.backfillClients))
  gated.route('/admin/nodes', createNodeRoutes(runtime))
  gated.route('/admin/templates', createTemplateRoutes(runtime))
  gated.route('/admin/tags', createTagRoutes(runtime, currentSeason))
  gated.route('/manifest', createManifestRoutes(runtime, { server, currentSeason }))
  gated.route('/archive', createCanvasHistoryRoutes(runtime, options.backfillClients))
  gated.route('/work', createWorkRoutes(runtime))
  gated.route('/chunks', createBlobRoutes(runtime, 'chunks'))
  gated.route('/sources', createBlobRoutes(runtime, 'sources'))
  gated.route('/tiles', createBlobRoutes(runtime, 'tiles'))
  gated.route('/recipes', createRecipeRoutes(runtime))
  gated.route(
    '/telemetry',
    createTelemetryRoutes(runtime, auth, {
      currentSeason,
      server,
      ...(options.connectPresence === undefined
        ? {}
        : { connectPresence: options.connectPresence }),
      ...(options.presenceOnline === undefined ? {} : { presenceOnline: options.presenceOnline }),
      ...(options.connectStatusLive === undefined
        ? {}
        : { connectStatusLive: options.connectStatusLive }),
    }),
  )

  // Both mounts share these exact route objects, so compatibility aliases cannot gain handlers or
  // contracts that differ from the versioned API. `open` mounts first: Hono runs handlers in
  // registration order, so its routes answer before `gated`'s hold can see them.
  for (const prefix of ['/v1', '/']) {
    app.route(prefix, open)
    app.route(prefix, gated)
  }

  return app
}

export type App = ReturnType<typeof createApp>
