import { SCOPES, type Scope } from '@caelestis/shared'
import { Hono } from 'hono'
import { MAX_LABEL_LENGTH } from '../auth/store.js'
import {
  listAccessTokens,
  mintAccessToken,
  revokeAccessTokenAndLiveSessions,
} from '../auth/use-cases.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { jsonObject } from './params.js'

/** The path segment a client names the bootstrap entry by; it has no stored digest. */
const BOOTSTRAP_KEY = 'bootstrap'

/**
 * The scopes an admin can mint. `event_runner` is kept only for tokens minted by backend 1.6.0
 * until a later release drops it (#984); anyone who can write hosts capture lobbies now.
 */
const MINTABLE_SCOPES = SCOPES.filter((scope) => scope !== 'event_runner')

const isMintable = (value: unknown): value is Scope =>
  typeof value === 'string' && (MINTABLE_SCOPES as readonly string[]).includes(value)

/**
 * Token administration, admin-only throughout: a `report` holder that could mint itself `admin`
 * would make the scope ladder decorative.
 */
export const createTokenRoutes = (
  runtime: BackendRuntime,
  options: { readonly currentSeason: number; readonly bootstrapConfigured: boolean },
) => {
  const routes = new Hono()

  routes.post('/', async (c) => {
    const body = await jsonObject(c)
    if (body === null) return c.json({ error: 'invalid body' }, 400)
    const { label, scope } = body
    if (typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      return c.json({ error: `label must be 1..${MAX_LABEL_LENGTH} characters` }, 400)
    }
    if (!isMintable(scope))
      return c.json({ error: `scope must be one of ${MINTABLE_SCOPES.join(', ')}` }, 400)

    return runBackendHttp(
      c,
      runtime,
      mintAccessToken({ label, scope, createdWithToken: c.get('caller').tokenHash }),
      (minted) => c.json(minted, 201),
    )
  })

  routes.get('/', async (c) =>
    runBackendHttp(
      c,
      runtime,
      listAccessTokens(c.req.query('cursor'), options.bootstrapConfigured),
      (page) => c.json(page),
    ),
  )

  routes.delete('/:tokenHash', async (c) => {
    const tokenHash = c.req.param('tokenHash')
    // The bootstrap credential lives in the deployment environment, not in this store.
    if (tokenHash === BOOTSTRAP_KEY) {
      return c.json({ error: 'the bootstrap token is set in the environment; unset it there' }, 400)
    }
    // 204 whether or not the row was there, so a retry after a lost response still succeeds and
    // the answer says nothing about whether a hash the caller does not hold exists.
    return runBackendHttp(
      c,
      runtime,
      revokeAccessTokenAndLiveSessions(tokenHash, options.currentSeason),
      () => c.body(null, 204),
    )
  })

  return routes
}
