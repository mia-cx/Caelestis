import type { Millis, Scope } from '@caelestis/shared'

/** A stored credential. The plaintext token exists only in the response that mints it. */
export interface AccessToken {
  /** Lowercase hex SHA-256 of the token. The primary key. */
  readonly tokenHash: string
  /** Human-facing name, so one leaked credential can be revoked without rotating everyone. */
  readonly label: string
  readonly scope: Scope
  readonly createdWithToken: string
  readonly createdAt: Millis
}

/** The last row of a token page, used for a stable newest-first keyset scan. */
export interface AccessTokenCursor {
  readonly createdAt: Millis
  readonly tokenHash: string
}

export interface AccessTokenQuery {
  readonly after?: AccessTokenCursor
  readonly limit?: number
}

export interface AccessTokenStore {
  /**
   * Store a freshly minted token. Rejects a hash that already exists rather than overwriting it: a
   * collision would silently transfer one holder's credential to another.
   */
  insertAccessToken(token: AccessToken): Promise<void>

  /** The token with this hash, or null if there is none — which is what revoked looks like. */
  readAccessToken(tokenHash: string): Promise<AccessToken | null>

  /**
   * Stored tokens newest first, tie-broken by hash. A query can continue strictly after a cursor and
   * bound the returned rows, so HTTP pagination never has to load the complete inventory.
   */
  listAccessTokens(query?: AccessTokenQuery): Promise<readonly AccessToken[]>

  /**
   * Revoke a token by deleting it, idempotently.
   *
   * A hard delete needs no reader to remember a `revoked` flag. What the token already reported
   * stays: reported state records what was on wplace, and revoking ends a holder's future access
   * rather than rewriting history.
   */
  revokeAccessToken(tokenHash: string): Promise<void>
}
