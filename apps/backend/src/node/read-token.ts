import { millis } from '@caelestis/shared'
import { coordinatorTransaction } from '../adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../adapters/node/coordinator-storage.js'
import { relationalSqlStore } from '../adapters/relational-sql-store.js'
import type { TransactionalSqlConnection } from '../adapters/sql-connection.js'
import { hashToken, mintToken } from '../auth/tokens.js'
import type { SqlStore } from '../ports/index.js'

const FRONTEND_TOKEN = 'frontend-token'

/**
 * The frontend's read token: the configured one, or one this server minted and stored on first
 * start. A configured token must already exist, unless no token was stored yet.
 */
export const provisionReadToken = async (
  connection: TransactionalSqlConnection,
  sql: SqlStore,
  serverState: SqlCoordinatorStorage,
  configured: string | undefined,
): Promise<string> => {
  const stored = await serverState.get<string>(FRONTEND_TOKEN)
  let readToken = configured ?? stored
  const mint = !stored && (!readToken || !(await sql.readAccessToken(await hashToken(readToken))))
  if (mint) {
    readToken ??= mintToken()
    const token = readToken
    const tokenHash = await hashToken(token)
    // One transaction, so a crash cannot leave a token the server does not remember minting.
    await connection.transaction(async (transaction) => {
      await relationalSqlStore(transaction).insertAccessToken({
        tokenHash,
        label: 'Built-in frontend',
        scope: 'read',
        createdWithToken: tokenHash,
        createdAt: millis(Date.now()),
      })
      await new SqlCoordinatorStorage(coordinatorTransaction(transaction), serverState.actor).put(
        FRONTEND_TOKEN,
        token,
      )
    })
  }
  if (!readToken) throw new Error('Missing frontend read token')
  const token = await sql.readAccessToken(await hashToken(readToken))
  if (token?.scope !== 'read')
    throw new Error(
      'CAELESTIS_READ_TOKEN must identify an active read-only token; the stored frontend token may have been revoked',
    )
  if (!stored && !mint) await serverState.put(FRONTEND_TOKEN, readToken)
  return readToken
}
