import type { Scope } from '@caelestis/shared'
import { isSha256Hex, millis, parseWholeNumber } from '@caelestis/shared'
import { Effect } from 'effect'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import {
  ForbiddenError,
  type StorageError,
  storage,
  UnauthorizedError,
  ValidationError,
} from '../runtime/errors.js'
import type { AccessToken } from './store.js'
import { hashToken, mintToken } from './tokens.js'

/**
 * A page of labels at `MAX_LABEL_LENGTH` control characters each stays below the userscript's
 * 64 KiB JSON cap.
 */
const TOKEN_PAGE_SIZE = 50

/**
 * Mint a token. The response is the only time its plaintext exists outside the caller's hands.
 *
 * An `event_runner` token is minted as a one-use invite: whoever is handed it trades it through
 * {@link exchangeInvite} for a token only their browser holds, so the shared secret stops working
 * the moment it is used.
 */
export const mintAccessToken = (input: {
  readonly label: string
  readonly scope: Scope
  readonly createdWithToken: string
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const token = mintToken()
    const tokenHash = yield* Effect.promise(() => hashToken(token))
    const record: AccessToken = {
      tokenHash,
      label: input.label,
      scope: input.scope,
      createdWithToken: input.createdWithToken,
      createdAt: millis(Date.now()),
      ...(input.scope === 'event_runner' ? { invite: true } : {}),
    }
    yield* storage('insertAccessToken', () => sql.insertAccessToken(record))
    return { token, ...record }
  })

/**
 * Trade the presented invite for a fresh token with the same label and scope, once. The invite
 * stops existing in the same write, so a second exchange finds nothing and is asked to
 * authenticate. A credential that is not an invite is refused and keeps working.
 */
export const exchangeInvite = (presented: string | null) =>
  Effect.gen(function* () {
    if (presented === null) return yield* Effect.fail(new UnauthorizedError())
    const sql = yield* SqlStoreService
    const inviteHash = yield* Effect.promise(() => hashToken(presented))
    const token = mintToken()
    const tokenHash = yield* Effect.promise(() => hashToken(token))
    const redeemed = yield* storage('redeemInvite', () =>
      sql.redeemInvite(inviteHash, { tokenHash, createdAt: millis(Date.now()) }),
    )
    if (redeemed) return { token }
    const held = yield* storage('readAccessToken', () => sql.readAccessToken(inviteHash))
    return yield* Effect.fail(held === null ? new UnauthorizedError() : new ForbiddenError())
  })

/** `createdAt:tokenHash` of the last token on the previous page. */
const parseCursor = (value: string) => {
  const [createdAt, tokenHash, ...rest] = value.split(':')
  const at = parseWholeNumber(createdAt)
  return at === null || tokenHash === undefined || !isSha256Hex(tokenHash) || rest.length > 0
    ? null
    : { createdAt: millis(at), tokenHash }
}

/**
 * One page of stored tokens, newest first. The first page leads with the bootstrap credential when
 * one is configured: it lives in the environment, so it has no row to page through.
 */
export const listAccessTokens = (cursor: string | undefined, bootstrapConfigured: boolean) =>
  Effect.gen(function* () {
    const after = cursor === undefined ? undefined : parseCursor(cursor)
    if (after === null)
      return yield* Effect.fail(new ValidationError({ message: 'cursor is invalid' }))
    const sql = yield* SqlStoreService
    const stored = yield* storage('listAccessTokens', () =>
      sql.listAccessTokens({
        ...(after === undefined ? {} : { after }),
        limit: TOKEN_PAGE_SIZE + 1,
      }),
    )
    const page = stored.slice(0, TOKEN_PAGE_SIZE)
    const last = page.at(-1)
    const nextCursor =
      stored.length > TOKEN_PAGE_SIZE && last !== undefined
        ? `${last.createdAt}:${last.tokenHash}`
        : null
    if (!bootstrapConfigured || after !== undefined) return { tokens: page, nextCursor }
    const bootstrap = {
      label: 'bootstrap',
      scope: 'admin' as const,
      // Unknown rather than invented: it was set whenever the server was deployed.
      createdAt: 0,
      // Said on the wire rather than inferred from the label, which anyone could give a real token.
      bootstrap: true,
    }
    return { tokens: [bootstrap, ...page], nextCursor }
  })

/**
 * Revoke a stored token and close every live session it opened. Absence is revocation, so revoking
 * a token that is already gone succeeds.
 */
export const revokeAccessTokenAndLiveSessions = (
  tokenHash: string,
  season: number,
): Effect.Effect<void, StorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    yield* storage('revokeAccessToken', () => sql.revokeAccessToken(tokenHash))
    const statusReadModel = yield* StatusReadModelService
    yield* storage('closeLiveCredential', () => statusReadModel.closeCredential(season, tokenHash))
  })
