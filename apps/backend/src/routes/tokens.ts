import { SCOPES, type Scope } from '@caelestis/shared'
import { Hono } from 'hono'
import {
  listAccessTokens,
  mintAccessToken,
  revokeAccessTokenAndLiveSessions,
} from '../auth/use-cases.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'

const MAX_LABEL_LENGTH = 128
const BOOTSTRAP_HASH = 'bootstrap'

const isScope = (value: unknown): value is Scope =>
  typeof value === 'string' && (SCOPES as readonly string[]).includes(value)

/**
 * Token administration, admin-only throughout: a `report` holder that could mint itself `admin`
 * would make the scope ladder decorative.
 *
 * @see .scratch/v1/issues/03-auth-model.md
 */
export const createTokenRoutes = (
  runtime: BackendRuntime,
  options: { readonly currentSeason: number; readonly bootstrapConfigured: boolean },
) => {
  const routes = new Hono()

  routes.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)

    const { label, scope } = body as { label?: unknown; scope?: unknown }
    if (typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      return c.json({ error: 'label must be 1..128 characters' }, 400)
    }
    if (!isScope(scope)) return c.json({ error: `scope must be one of ${SCOPES.join(', ')}` }, 400)

    const caller = c.get('caller')
    return runBackendHttp(
      c,
      runtime,
      mintAccessToken({
        label,
        scope,
        // The bootstrap operator has no row of its own, so it is named rather than referenced.
        createdWithToken: caller.token?.tokenHash ?? BOOTSTRAP_HASH,
      }),
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
    if (tokenHash === BOOTSTRAP_HASH) {
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
