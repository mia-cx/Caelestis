import type { ServerInfo } from '@caelestis/shared'
import { Context as Services } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ArchiveHost } from './archive/port.js'
import { requireScopeEffect } from './auth/middleware.js'
import { archiveHold, createArchiveAdminRoutes } from './routes/archive.js'
import { createAuthRoutes } from './routes/auth.js'
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
  readonly archive?: ArchiveHost | undefined
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
  const bootstrapConfigured = options.bootstrapAdminToken !== undefined

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

  // Answers while an archive operation holds the server: identity, and the archive itself.
  const open = new Hono()
  open.route('/server', createServerRoutes(runtime, server))
  open.use('/admin/archive/*', admin)
  open.route('/admin/archive', createArchiveAdminRoutes(options.archive))

  // Everything else waits out an archive operation. Each mount declares its scope; a route that
  // needs more than its mount, such as a `report` write under `read`, says so itself. `open`
  // mounts authenticate per route or not at all.
  const gated = new Hono()
  gated.use('/*', archiveHold(Services.get(context, SqlStoreService)))
  gated.use('/admin/*', admin)
  const mounts: readonly (readonly [
    path: string,
    routes: Hono,
    scope: 'admin' | 'read' | 'open',
  ])[] = [
    ['/server/assets', createServerAssetRoutes(runtime), 'open'],
    ['/admin/server', createServerAdminRoutes(runtime, currentSeason), 'admin'],
    ['/admin/tokens', createTokenRoutes(runtime, { currentSeason, bootstrapConfigured }), 'admin'],
    ['/admin/backfill', createBackfillAdminRoutes(runtime), 'admin'],
    ['/admin/nodes', createNodeRoutes(runtime), 'admin'],
    ['/admin/templates', createTemplateRoutes(runtime), 'admin'],
    ['/admin/tags', createTagRoutes(runtime, currentSeason), 'admin'],
    ['/manifest', createManifestRoutes(runtime, { server, currentSeason }), 'read'],
    ['/archive', createCanvasHistoryRoutes(runtime), 'read'],
    ['/work', createWorkRoutes(runtime), 'read'],
    ['/chunks', createBlobRoutes(runtime, 'chunks'), 'read'],
    ['/sources', createBlobRoutes(runtime, 'sources'), 'read'],
    ['/tiles', createBlobRoutes(runtime, 'tiles'), 'read'],
    ['/recipes', createRecipeRoutes(runtime), 'read'],
    ['/telemetry', createTelemetryRoutes(runtime, auth, { currentSeason, server }), 'open'],
    ['/auth', createAuthRoutes(runtime, auth), 'open'],
  ]
  for (const [path, routes, scope] of mounts) {
    // `/admin/*` above guards every admin mount, so its place in the path is its scope.
    if ((scope === 'admin') !== path.startsWith('/admin/'))
      throw new Error(`${path}: admin routes mount under /admin, and only they do`)
    if (scope === 'read') gated.use(`${path}/*`, read)
    gated.route(path, routes)
  }

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
