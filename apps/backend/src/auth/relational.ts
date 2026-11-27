import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm'
import { changedRows } from '../adapters/relational-database.js'
import { RelationalStore } from '../adapters/relational-store.js'
import { accessTokens } from '../db/schema.js'
import type { AccessToken, AccessTokenQuery, AccessTokenStore } from './store.js'

const toAccessToken = (row: typeof accessTokens.$inferSelect): AccessToken => ({
  tokenHash: row.tokenHash,
  label: row.label,
  scope: row.scope,
  createdWithToken: row.createdWithToken,
  createdAt: row.createdAtMs,
  ...(row.inviteHash === row.tokenHash ? { invite: true } : {}),
})

export class RelationalAccessTokenStore extends RelationalStore implements AccessTokenStore {
  async insertAccessToken(token: AccessToken): Promise<void> {
    await this.database.insert(accessTokens).values({
      tokenHash: token.tokenHash,
      label: token.label,
      scope: token.scope,
      createdWithToken: token.createdWithToken,
      createdAtMs: token.createdAt,
      inviteHash: token.invite === true ? token.tokenHash : null,
    })
  }

  async readAccessToken(tokenHash: string): Promise<AccessToken | null> {
    const rows = await this.database
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.tokenHash, tokenHash))
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : toAccessToken(row)
  }

  async redeemInvite(
    inviteHash: string,
    replacement: Pick<AccessToken, 'tokenHash' | 'createdAt'>,
  ): Promise<boolean> {
    const result = await this.database
      .update(accessTokens)
      .set({ tokenHash: replacement.tokenHash, createdAtMs: replacement.createdAt })
      .where(and(eq(accessTokens.tokenHash, inviteHash), eq(accessTokens.inviteHash, inviteHash)))
      .run()
    return changedRows(result) === 1
  }

  async listAccessTokens(query: AccessTokenQuery = {}): Promise<readonly AccessToken[]> {
    const after = query.after
    const ordered = this.database
      .select()
      .from(accessTokens)
      .where(
        after === undefined
          ? undefined
          : or(
              lt(accessTokens.createdAtMs, after.createdAt),
              and(
                eq(accessTokens.createdAtMs, after.createdAt),
                gt(accessTokens.tokenHash, after.tokenHash),
              ),
            ),
      )
      .orderBy(desc(accessTokens.createdAtMs), asc(accessTokens.tokenHash))
      .$dynamic()
    const rows = await (query.limit === undefined ? ordered : ordered.limit(query.limit))
    return rows.map(toAccessToken)
  }

  async revokeAccessToken(tokenHash: string): Promise<string | null> {
    // A redemption can rotate the hash between the read and the delete, at most once, so a delete
    // that misses reads again rather than reporting the old hash it never removed.
    for (;;) {
      const [row] = await this.database
        .select({ tokenHash: accessTokens.tokenHash })
        .from(accessTokens)
        .where(or(eq(accessTokens.tokenHash, tokenHash), eq(accessTokens.inviteHash, tokenHash)))
        .limit(1)
      if (row === undefined) return null
      const result = await this.database
        .delete(accessTokens)
        .where(eq(accessTokens.tokenHash, row.tokenHash))
        .run()
      if (changedRows(result) === 1) return row.tokenHash
    }
  }
}
