import {
  decodePresenceServerEvent,
  type PainterIdentity,
  type RegionClaim,
  type RegionClaimRequest,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { warn } from './debug.js'
import { activeServerToken, isCurrentServerConnection } from './server-connections.js'
import { requestServerMutation, requestServerTree } from './server-transport.js'
import { serverEndpoint } from './server-url.js'
import type { ConnectedServer } from './settings.js'
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

const scopedEndpoint = (server: ConnectedServer, path: string, scope?: ClaimScope): URL => {
  const endpoint = new URL(serverEndpoint(server.url, path))
  endpoint.searchParams.set('season', String(scope?.season ?? server.season))
  endpoint.searchParams.set('surface', (scope?.surface ?? WORLD_TEMPLATE_SURFACE).kind)
  if (scope !== undefined && scope.surface.allianceId !== null)
    endpoint.searchParams.set('allianceId', String(scope.surface.allianceId))
  return endpoint
}

const regionRequest = async (
  server: ConnectedServer,
  method: 'PUT' | 'DELETE',
  id: string,
  body: unknown,
  scope?: ClaimScope,
  signal?: AbortSignal,
): Promise<RegionWriteResult> => {
  if (server.season === null) return failed('Server season unknown.')
  const token = activeServerToken(server)
  if (token === null) return failed('Sign in to this server to claim regions.')
  try {
    const { response, body: answer } = await requestServerMutation(
      scopedEndpoint(server, `/work/regions/${id}`, scope).toString(),
      {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    )
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
  server: ConnectedServer,
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
  server: ConnectedServer,
  id: string,
  actor: PainterIdentity,
  scope?: ClaimScope,
  signal?: AbortSignal,
  withdraw = false,
): Promise<RegionWriteResult> => {
  const result = await regionRequest(server, 'DELETE', id, { actor, withdraw }, scope, signal)
  return result.kind === 'deleted' ? OK : result
}

/** A server's claims as its HTTP snapshot reports them. */
export interface RegionSnapshot {
  readonly regions: readonly RegionClaim[]
  readonly ownedRegionIds: readonly string[]
  readonly canWrite: boolean
}

const fetchRegions = async (
  server: ConnectedServer,
  signal: AbortSignal,
): Promise<RegionSnapshot | null> => {
  const endpoint = scopedEndpoint(server, '/work/regions')
  const actor = accountIdentity()
  if (actor !== null) endpoint.searchParams.set('painterId', String(actor.wplaceUserId))
  const token = activeServerToken(server)
  const { response, body } = await requestServerTree(endpoint.toString(), {
    signal,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })
  if (!response.ok || typeof body !== 'object' || body === null || !('regions' in body)) return null
  const event = decodePresenceServerEvent({ ...body, type: 'regions' })
  if (event === null || event === 'unknown' || event.type !== 'regions') return null
  return {
    regions: event.regions,
    ownedRegionIds: event.ownedRegionIds ?? [],
    canWrite: 'canWrite' in body && body.canWrite === true,
  }
}

/**
 * Read a server's claims now and every `CLAIM_SNAPSHOT_MS` after, so persisted claims stay
 * readable when admission limits or network failures prevent a socket. Returns the stop.
 */
export const pollRegionSnapshots = (
  server: ConnectedServer,
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
        if (!signal.aborted) warn('install', 'claim snapshot failed', String(error))
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
