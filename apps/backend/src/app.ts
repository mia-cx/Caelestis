import type { ServerInfo } from '@caelestis/shared'
import { Context as Services } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ArchiveHost } from './archive/port.js'
import { requireScopeEffect } from './auth/middleware.js'
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

export interface AppOptions {
  /** What `/server` and every manifest advertise; hosts build it with `serverInfo`. */
  readonly server: ServerInfo
  readonly currentSeason: number
  /**
   * The operator's bootstrap credential. Absent means the server has no bootstrap path, which is
   * the right state once a real admin token has been minted.
   */
  readonly bootstrapAdminToken?: string | undefined
  /** Relational runtimes can export and restore complete server archives. */
  readonly archive?: ArchiveHost
}

/** The Hono app over the context's ports. It holds no runtime binding; `composeBackend` adds them. */
export const createApp = (context: BackendContext, options: AppOptions) => {
  const app = new Hono()
  const runtime = createBackendRuntime(context)
  const { server, currentSeason } = options
  const auth = {
    bootstrapAdminToken: options.bootstrapAdminToken,
    // What `/server` advertises is what the server enforces.
    openAccess: server.auth === 'none',
  }
  const bootstrapConfigured =
    options.bootstrapAdminToken !== undefined && options.bootstrapAdminToken.length > 0

  // The userscript runs on wplace.live and calls this server cross-origin. `ETag` is not a
  // CORS-safelisted response header, so it must be exposed or the userscript reads `null` and can
  // never send `If-None-Match`. Every request carries `Authorization`, so each one is preflighted;
  // the policy is constant, so the preflight answer is cached. Browsers clamp `maxAge` (Chromium at
  // 2 hours, Safari at 10 minutes), so the number is only a ceiling.
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
            await Services.get(context, StatusReadModelService).notifyManifestChange(currentSeason)
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
  gated.route('/admin/backfill', createBackfillAdminRoutes(runtime))
  gated.route('/admin/nodes', createNodeRoutes(runtime))
  gated.route('/admin/templates', createTemplateRoutes(runtime))
  gated.route('/admin/tags', createTagRoutes(runtime, currentSeason))
  gated.route('/manifest', createManifestRoutes(runtime, { server, currentSeason }))
  gated.route('/archive', createCanvasHistoryRoutes(runtime))
  gated.route('/work', createWorkRoutes(runtime))
  gated.route('/chunks', createBlobRoutes(runtime, 'chunks'))
  gated.route('/sources', createBlobRoutes(runtime, 'sources'))
  gated.route('/tiles', createBlobRoutes(runtime, 'tiles'))
  gated.route('/recipes', createRecipeRoutes(runtime))
  gated.route('/telemetry', createTelemetryRoutes(runtime, auth, { currentSeason, server }))

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
