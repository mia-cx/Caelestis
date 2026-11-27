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
      .where(and(eq(accessTokens.tokenHash, tokenHash), eq(accessTokens.revoked, false)))
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
      .where(
        and(
          eq(accessTokens.tokenHash, inviteHash),
          eq(accessTokens.inviteHash, inviteHash),
          eq(accessTokens.revoked, false),
        ),
      )
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
    const named = or(eq(accessTokens.tokenHash, tokenHash), eq(accessTokens.inviteHash, tokenHash))
    // Marked first: a revoked invite cannot be redeemed, so the hash read next is the final one.
    await this.database.update(accessTokens).set({ revoked: true }).where(named).run()
    const [row] = await this.database
      .select({ tokenHash: accessTokens.tokenHash })
      .from(accessTokens)
      .where(named)
      .limit(1)
    return row?.tokenHash ?? null
  }

  async forgetAccessToken(tokenHash: string): Promise<void> {
    await this.database
      .delete(accessTokens)
      .where(and(eq(accessTokens.tokenHash, tokenHash), eq(accessTokens.revoked, true)))
  }
}
