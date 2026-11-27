import { millis } from '@caelestis/shared'
import { createApp } from '../../backend/dist/app.js'
import { hashToken } from '../../backend/dist/auth/tokens.js'
import { openMemoryStores } from '../../backend/dist/node/memory-stores.js'
import { makeBackendContext } from '../../backend/dist/runtime/backend-runtime.js'

export const adminToken = 'USERSCRIPT-CONTRACT-ADMIN'
export const reportToken = 'USERSCRIPT-CONTRACT-REPORT'
export const readToken = 'USERSCRIPT-CONTRACT-READ'

const serverPath = (url: URL): string =>
  url.pathname.replace(/^\/backend(?:\/v1)?(?=\/|$)/, (prefix) =>
    prefix.endsWith('/v1') ? '/v1' : '',
  )

/** Route the userscript's configured `/backend/v1` URL through the real backend Hono app. */
export const backendFetch =
  (app: { fetch(request: Request): Response | Promise<Response> }, origin: string): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== origin)
      throw new Error(`unexpected server request: ${request.method} ${url}`)
    return await app.fetch(
      new Request(`https://backend.test${serverPath(url)}${url.search}`, request),
    )
  }

/** Mint a one-use event-runner invite on `origin`'s backend, as its admin would. */
export const mintEventRunnerInvite = async (fetch: typeof globalThis.fetch, origin: string) => {
  const response = await fetch(`${origin}/v1/admin/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Organiser', scope: 'event_runner' }),
  })
  const { token } = (await response.json()) as { token: string }
  return token
}

/** Exercise the built backend package without loading its compiler environment into Vitest. */
export const createTestBackend = async ({
  openAccess = false,
  ...release
}: {
  openAccess?: boolean
  version?: string
  build?: string
} = {}) => {
  const { sql, blobs, counters } = await openMemoryStores()
  const tokenHash = await hashToken(adminToken)
  await sql.insertAccessToken({
    tokenHash,
    label: 'Userscript contract admin',
    scope: 'admin',
    createdWithToken: tokenHash,
    createdAt: millis(1),
  })
  const reportTokenHash = await hashToken(reportToken)
  await sql.insertAccessToken({
    tokenHash: reportTokenHash,
    label: 'Userscript contract reporter',
    scope: 'report',
    createdWithToken: tokenHash,
    createdAt: millis(2),
  })
  const readTokenHash = await hashToken(readToken)
  await sql.insertAccessToken({
    tokenHash: readTokenHash,
    label: 'Userscript contract reader',
    scope: 'read',
    createdWithToken: tokenHash,
    createdAt: millis(3),
  })
  return {
    app: createApp(makeBackendContext(blobs, sql, counters), {
      server: {
        id: '00000000-0000-7000-8000-000000000000',
        name: 'Userscript contract server',
        auth: openAccess ? 'none' : 'access_token',
        ...release,
      },
      currentSeason: 3,
    }),
  }
}
