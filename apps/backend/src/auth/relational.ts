import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm'
import { RelationalStore } from '../adapters/relational-store.js'
import { accessTokens } from '../db/schema.js'
import type { AccessToken, AccessTokenQuery, AccessTokenStore } from './store.js'

const toAccessToken = (row: typeof accessTokens.$inferSelect): AccessToken => ({
  tokenHash: row.tokenHash,
  label: row.label,
  scope: row.scope,
  createdWithToken: row.createdWithToken,
  createdAt: row.createdAtMs,
})

export class RelationalAccessTokenStore extends RelationalStore implements AccessTokenStore {
  async insertAccessToken(token: AccessToken): Promise<void> {
    // No onConflict clause: the primary key must reject a duplicate hash rather than overwrite it,
    // which would silently transfer one holder's credential to another.
    await this.database.insert(accessTokens).values({
      tokenHash: token.tokenHash,
      label: token.label,
      scope: token.scope,
      createdWithToken: token.createdWithToken,
      createdAtMs: token.createdAt,
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

  async revokeAccessToken(tokenHash: string): Promise<void> {
    // A delete, not a flag. Idempotent because deleting an absent row is a no-op, and nothing
    // references this table — the reporter and author digests are shape-checked, not foreign keys —
    // so the reports this credential wrote survive it. That is deliberate: reported state records
    // what was on wplace, and revoking a credential ends its future access rather than editing the
    // past.
    await this.database.delete(accessTokens).where(eq(accessTokens.tokenHash, tokenHash))
  }
}
