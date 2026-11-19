import {
  decodeRegionSnapshot,
  type PainterIdentity,
  type RegionClaim,
  type RegionClaimRequest,
  type RegionSnapshot,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { warn } from './debug.js'
import { activeServerToken, isCurrentServerConnection } from './server-connections.js'
import { serverRequest } from './server-request.js'
import type { ServerConnection } from './settings.js'
import { accountIdentity } from './wplace-account.js'

/**
 * Region claims over HTTP: writing and releasing one claim, and reading a server's claims while no
 * presence socket carries them.
 */

const CLAIM_SNAPSHOT_MS = 30_000

/** A write either landed, found the claim deleted for good, or failed in a way worth retrying. */
export type RegionWriteResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'error'; readonly message: string }

const OK: RegionWriteResult = { kind: 'ok' }
const failed = (message: string): RegionWriteResult => ({ kind: 'error', message })

type ClaimScope = Pick<RegionClaim, 'season' | 'surface'>

const scopeQuery = (server: ServerConnection, scope?: ClaimScope): Record<string, string> => ({
  season: String(scope?.season ?? server.season),
  surface: (scope?.surface ?? WORLD_TEMPLATE_SURFACE).kind,
  ...(scope !== undefined && scope.surface.allianceId !== null
    ? { allianceId: String(scope.surface.allianceId) }
    : {}),
})

const regionRequest = async (
  server: ServerConnection,
  method: 'PUT' | 'DELETE',
  id: string,
  body: unknown,
  scope?: ClaimScope,
  signal?: AbortSignal,
): Promise<RegionWriteResult> => {
  if (server.season === null) return failed('Server season unknown.')
  if (activeServerToken(server) === null) return failed('Sign in to this server to claim regions.')
  try {
    const { response, body: answer } = await serverRequest(server, `/work/regions/${id}`, {
      method,
      query: scopeQuery(server, scope),
      json: body,
      limits: 'mutation',
      read: 'json',
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.ok || (method === 'DELETE' && response.status === 404)) return OK
    if (response.status === 410) return { kind: 'deleted' }
    return failed(
      typeof answer === 'object' &&
        answer !== null &&
        typeof (answer as { error?: unknown }).error === 'string'
        ? (answer as { error: string }).error
        : `Server answered ${response.status}.`,
    )
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'Region request failed.')
  }
}

/** Persist a claim, distinguishing permanent deletion from a retryable failure. */
export const claimRegion = (
  server: ServerConnection,
  id: string,
  request: RegionClaimRequest,
  scope?: ClaimScope,
  signal?: AbortSignal,
): Promise<RegionWriteResult> => regionRequest(server, 'PUT', id, request, scope, signal)

/**
 * Delete a logical claim, or withdraw just this server's replica for later reconnection. A claim
 * the server already deleted for good is released.
 */
export const releaseRegion = async (
  server: ServerConnection,
  id: string,
  actor: PainterIdentity,
  scope?: ClaimScope,
  signal?: AbortSignal,
  withdraw = false,
): Promise<RegionWriteResult> => {
  const result = await regionRequest(server, 'DELETE', id, { actor, withdraw }, scope, signal)
  return result.kind === 'deleted' ? OK : result
}

const fetchRegions = async (
  server: ServerConnection,
  signal: AbortSignal,
): Promise<RegionSnapshot | null> => {
  const actor = accountIdentity()
  const { response, body } = await serverRequest(server, '/work/regions', {
    query: {
      ...scopeQuery(server),
      ...(actor === null ? {} : { painterId: String(actor.wplaceUserId) }),
    },
    limits: 'tree',
    read: 'json',
    signal,
  })
  return response.ok ? decodeRegionSnapshot(body) : null
}

/**
 * Read a server's claims now and every `CLAIM_SNAPSHOT_MS` after, so persisted claims stay
 * readable when admission limits or network failures prevent a socket. Returns the stop.
 */
export const pollRegionSnapshots = (
  server: ServerConnection,
  apply: (snapshot: RegionSnapshot) => void,
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller = new AbortController()
  const poll = (): void => {
    timer = null
    controller = new AbortController()
    const { signal } = controller
    void fetchRegions(server, signal)
      .then((snapshot) => {
        if (snapshot !== null && !signal.aborted && isCurrentServerConnection(server))
          apply(snapshot)
      })
      .catch((error: unknown) => {
        if (!signal.aborted) warn('claim snapshot failed', String(error))
      })
      .finally(() => {
        if (signal.aborted || !isCurrentServerConnection(server)) return
        timer = setTimeout(poll, CLAIM_SNAPSHOT_MS)
      })
  }
  poll()
  return () => {
    if (timer !== null) clearTimeout(timer)
    controller.abort()
  }
}
