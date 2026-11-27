import { Hono } from 'hono'
import { type AuthOptions, bearerToken, requireScopeEffect } from '../auth/middleware.js'
import { exchangeInvite } from '../auth/use-cases.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'

/**
 * The caller's own credential. `GET /` says what scope it holds, so a client offers only the
 * controls the server will honour. `POST /exchange` authenticates itself, because an invite is
 * refused everywhere else.
 */
export const createAuthRoutes = (runtime: BackendRuntime, auth: AuthOptions) => {
  const routes = new Hono()

  routes.get('/', requireScopeEffect(runtime, auth, 'read'), (c) =>
    c.json({ scope: c.get('caller').scope }),
  )

  routes.post('/exchange', async (c) =>
    runBackendHttp(
      c,
      runtime,
      exchangeInvite(bearerToken(c.req.header('authorization'))),
      (exchanged) => c.json(exchanged, 201),
    ),
  )

  return routes
}
