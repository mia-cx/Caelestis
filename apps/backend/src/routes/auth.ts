import type { TerritoryTeam } from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, bearerToken, requireScopeEffect } from '../auth/middleware.js'
import { exchangeInvite } from '../auth/use-cases.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { jsonObject } from './params.js'

const isTeam = (value: unknown): value is TerritoryTeam =>
  value === 0 || value === 1 || value === 2 || value === 3

/**
 * The caller's own credential. `GET /` says what scope it holds, so a client offers only the
 * controls the server will honour. `POST /exchange` authenticates itself, because an invite is
 * refused everywhere else. On an event server its optional `{ team }` body binds the redeemed
 * token to the redeemer's event team; elsewhere the body is ignored.
 */
export const createAuthRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  options: { readonly eventServer: boolean },
) => {
  const routes = new Hono()

  routes.get('/', requireScopeEffect(runtime, auth, 'read'), (c) =>
    c.json({ scope: c.get('caller').scope }),
  )

  routes.post('/exchange', async (c) => {
    // Clients from before team binding send no body, so a missing one names no team.
    const team = options.eventServer ? (await jsonObject(c))?.team : undefined
    if (team !== undefined && !isTeam(team)) return c.json({ error: 'team must be 0..3' }, 400)
    return runBackendHttp(
      c,
      runtime,
      exchangeInvite(bearerToken(c.req.header('authorization')), team),
      (exchanged) => c.json(exchanged, 201),
    )
  })

  return routes
}
