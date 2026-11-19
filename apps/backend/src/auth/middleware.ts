import { type Scope, satisfiesScope } from '@caelestis/shared'
import { Effect } from 'effect'
import type { MiddlewareHandler } from 'hono'
import { type BackendRuntime, SqlStoreService } from '../runtime/backend-runtime.js'
import { ForbiddenError, type StorageError, storage, UnauthorizedError } from '../runtime/errors.js'
import { errorResponse, runBackendMiddleware } from '../runtime/hono.js'
import type { AccessToken } from './store.js'
import { hashToken } from './tokens.js'

/** What a request proved about itself. */
export interface Caller {
  readonly scope: Scope
  /** The stored credential, or null for the bootstrap operator token, which has no row. */
  readonly token: AccessToken | null
  /**
   * The digest of whatever credential authenticated this request, bootstrap included.
   *
   * `token` is null for the operator secret because it has no `access_tokens` row, and callers that
   * record authorship still need something to record. Every author column is a 64-character hex
   * digest by CHECK, so a literal like `'bootstrap'` is not storable — this is.
   */
  readonly tokenHash: string
  /** Admins see unpublished templates and their artwork; everyone else sees what is published. */
  readonly canSeeDrafts: boolean
}

declare module 'hono' {
  interface ContextVariableMap {
    caller: Caller
  }
}

/** Only the `Bearer <token>` form. `Basic` and bare tokens are not accepted. */
const bearerToken = (header: string | undefined): string | null => {
  if (header === undefined) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length !== 1) return null
  const token = rest[0]
  return token === undefined || token.length === 0 ? null : token
}

/**
 * Constant-time string comparison, for the bootstrap token.
 *
 * The stored tokens are compared by SHA-256 hash, where a timing leak reveals nothing an attacker
 * can use — they would learn a prefix of a hash they cannot invert. The operator token is compared
 * raw, so it gets the real thing.
 */
const equalsConstantTime = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  // Length is not secret — it is visible in the request — so returning early on it is fine, and the
  // alternative would compare buffers of different sizes.
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    // biome-ignore lint/style/noNonNullAssertion: index is inside both arrays
    difference |= a[index]! ^ b[index]!
  }
  return difference === 0
}

export interface AuthOptions {
  /**
   * The operator's bootstrap credential, from the environment.
   *
   * It mints the first real admin token and is not expected on ordinary requests. Absent or empty
   * means the server has no bootstrap path, which is the right default once real tokens exist.
   */
  readonly bootstrapAdminToken?: string | undefined

  /**
   * Serve the read surface without a credential.
   *
   * `/server` advertises `auth: 'none'` when this is set, and that advertisement is the entire
   * reason `/server` is public: a userscript reads it to decide whether to ask its user for a token
   * before adding the server. So the flag must open the reads too, or a client that believed the
   * advertisement would get a 401 from `/manifest`.
   *
   * `read` only. `report` writes counters and `admin` writes everything, and neither becomes public
   * because a server chose to publish its manifest.
   *
   * A credential that is presented is still read: an admin on an open server must keep seeing
   * drafts. A credential that is presented and invalid still fails, rather than quietly falling back
   * to anonymous — a holder whose token was revoked needs to learn that, and anyone who wants the
   * anonymous view can have it by sending no header at all.
   */
  readonly openAccess?: boolean | undefined
}

/**
 * The caller for a tokenless read: an anonymous request on an open server, or the server reading
 * itself in-process. Its digest is not a credential and cannot be one: no token hashes to all
 * zeroes, so it never collides with a real one, and author columns still receive the right shape.
 */
const TOKENLESS_READER: Caller = {
  scope: 'read',
  token: null,
  tokenHash: '0'.repeat(64),
  canSeeDrafts: false,
}

/**
 * Marks a request the server makes to its own app, such as the share-image renderer reading the
 * API it serves: `app.fetch(request, { [IN_PROCESS_READ]: true })`. It grants `read` without a
 * stored token. A symbol key in Hono's per-request env cannot arrive over the network — no host
 * adapter puts one there — so only code holding this export can claim it.
 */
export const IN_PROCESS_READ = Symbol('in-process read')

/**
 * Authenticate one request, requiring at least `required` scope. `inProcess` is whether the
 * request carries `IN_PROCESS_READ`.
 *
 * Every rejection is a bare 401 or 403: the body is a constant per status, identical for a missing
 * header, a malformed scheme, an unknown token and a deleted one. Distinguishing them would let a
 * holder of one credential probe for the existence of others. 401 versus 403 is the one deliberate
 * distinction — it tells a caller whether to authenticate or give up.
 */
export const authenticateRequest = (
  authorization: string | undefined,
  config: AuthOptions,
  required: Scope,
  inProcess = false,
): Effect.Effect<Caller, UnauthorizedError | ForbiddenError | StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const presented = bearerToken(authorization)
    if (presented === null) {
      const tokenless = required === 'read' && (inProcess || config.openAccess === true)
      return tokenless ? TOKENLESS_READER : yield* Effect.fail(new UnauthorizedError())
    }

    const tokenHash = yield* Effect.promise(() => hashToken(presented))
    if (
      config.bootstrapAdminToken !== undefined &&
      config.bootstrapAdminToken.length > 0 &&
      equalsConstantTime(presented, config.bootstrapAdminToken)
    ) {
      return { scope: 'admin', token: null, tokenHash, canSeeDrafts: true }
    }

    const sql = yield* SqlStoreService
    const token = yield* storage('readAccessToken', () => sql.readAccessToken(tokenHash))
    if (token === null) return yield* Effect.fail(new UnauthorizedError())
    if (!satisfiesScope(token.scope, required)) return yield* Effect.fail(new ForbiddenError())
    return { scope: token.scope, token, tokenHash, canSeeDrafts: token.scope === 'admin' }
  })

/** Authenticate every request a mount guards and record its `caller`. */
export const requireScopeEffect =
  (runtime: BackendRuntime, config: AuthOptions, required: Scope): MiddlewareHandler =>
  async (c, next) => {
    const env: { [IN_PROCESS_READ]?: boolean } | undefined = c.env
    return runBackendMiddleware(
      c,
      runtime,
      authenticateRequest(
        c.req.header('authorization'),
        config,
        required,
        env?.[IN_PROCESS_READ] === true,
      ),
      (caller) => {
        c.set('caller', caller)
        return next()
      },
    )
  }

/**
 * Raise one route above its mount's scope, such as a `report` write under a `read` mount. The
 * mount already authenticated the caller, so this only compares scopes: a tokenless reader is
 * asked to authenticate, and anyone else holding too little is refused.
 */
export const requireScope =
  (required: Scope): MiddlewareHandler =>
  async (c, next) => {
    const caller = c.get('caller')
    if (satisfiesScope(caller.scope, required)) return next()
    return errorResponse(
      c,
      caller === TOKENLESS_READER ? new UnauthorizedError() : new ForbiddenError(),
    )
  }
