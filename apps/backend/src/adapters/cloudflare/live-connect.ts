import {
  isSha256Hex,
  isUuidV7,
  isWorkIdentity,
  parseWholeNumber,
  SCOPES,
  type Scope,
  templateSurface,
} from '@caelestis/shared'
import type { StatusLiveConnection } from '../../live/session.js'
import {
  type CacheOutcome,
  type D1Usage,
  measureD1Usage,
  mergeD1Usage,
  recordCacheOutcome,
} from '../../metrics/request-metrics.js'
import type { PresenceConnection } from '../../presence/port.js'
import type { LiveAdmission } from '../../status-coordinator.js'

/**
 * A Durable Object can only return a WebSocket from `fetch`, so a live connection crosses from the
 * Worker to its season or room object as an HTTP request. This module is that hop's codec: the
 * Worker writes the authenticated connection into `x-caelestis-*` headers, the object reads it
 * back, and the D1 work the object did on the request's behalf returns in response headers so the
 * Worker's request metric still counts it.
 */

interface Fetchable {
  fetch(request: Request): Promise<Response>
}

const SEASON = 'x-caelestis-season'
const TOKEN_HASH = 'x-caelestis-token-hash'
const CLIENT_HASH = 'x-caelestis-client-hash'
const CREDENTIAL_SCOPE = 'x-caelestis-credential-scope'
const ANONYMOUS = 'x-caelestis-anonymous'
const REVOCABLE = 'x-caelestis-revocable'
const METRIC_CLIENT = 'x-caelestis-metric-client'
const METRIC_CLIENT_VERSION = 'x-caelestis-metric-client-version'
const SCOPE = 'x-caelestis-scope'
const PROTOCOL = 'x-caelestis-live-protocol'
const REVISION = 'x-caelestis-revision'
const STATE_VECTOR = 'x-caelestis-state-vector'
const SURFACE_KIND = 'x-caelestis-surface-kind'
const ALLIANCE_ID = 'x-caelestis-alliance-id'
const PAINTER_ID = 'x-caelestis-painter-id'
const PAINTER_NAME = 'x-caelestis-painter-name'
const PUBLISHER_ID = 'x-caelestis-publisher-id'
const D1_USAGE = 'x-caelestis-live-d1-usage'
const CACHE_OUTCOME = 'x-caelestis-live-cache-outcome'

/** What every live connection carries, live sync and presence alike. */
interface Credential {
  readonly season: number
  readonly tokenHash: string
  readonly clientHash: string
  readonly credentialScope: Scope
  readonly anonymous: boolean
  readonly revocable: boolean
  readonly metricClient: string
  readonly metricClientVersion: string
}

const flag = (value: boolean): string => (value ? '1' : '0')

const readFlag = (value: string | null): boolean | null =>
  value === '1' ? true : value === '0' ? false : null

const forwardRequest = (request: Request, credential: Credential): Headers => {
  const headers = new Headers(request.headers)
  headers.delete('authorization')
  headers.set(SEASON, String(credential.season))
  headers.set(TOKEN_HASH, credential.tokenHash)
  headers.set(CLIENT_HASH, credential.clientHash)
  headers.set(CREDENTIAL_SCOPE, credential.credentialScope)
  headers.set(ANONYMOUS, flag(credential.anonymous))
  headers.set(REVOCABLE, flag(credential.revocable))
  headers.set(METRIC_CLIENT, credential.metricClient)
  headers.set(METRIC_CLIENT_VERSION, credential.metricClientVersion)
  return headers
}

const readCredential = (headers: Headers): Credential | null => {
  const season = parseWholeNumber(headers.get(SEASON))
  const tokenHash = headers.get(TOKEN_HASH)
  const clientHash = headers.get(CLIENT_HASH)
  const credentialScope = SCOPES.find((scope) => scope === headers.get(CREDENTIAL_SCOPE))
  const anonymous = readFlag(headers.get(ANONYMOUS))
  const revocable = readFlag(headers.get(REVOCABLE))
  if (
    season === null ||
    !isSha256Hex(tokenHash) ||
    !isSha256Hex(clientHash) ||
    credentialScope === undefined ||
    anonymous === null ||
    revocable === null
  )
    return null
  return {
    season,
    tokenHash,
    clientHash,
    credentialScope,
    anonymous,
    revocable,
    metricClient: headers.get(METRIC_CLIENT) ?? 'unknown',
    metricClientVersion: headers.get(METRIC_CLIENT_VERSION) ?? 'unknown',
  }
}

/** Answer anything but a WebSocket upgrade, or a connection that does not decode, by refusing it. */
const receive = async <A>(
  request: Request,
  read: (headers: Headers) => A | null,
  connect: (connection: A) => Promise<Response>,
): Promise<Response> => {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return new Response('WebSocket upgrade required', { status: 426 })
  const connection = read(request.headers)
  if (connection === null) return new Response('Invalid live connection', { status: 400 })
  return connect(connection)
}

/** Copy a response with extra headers, keeping its WebSocket. */
const withHeaders = (response: Response, extra: Headers, remove: readonly string[]): Response => {
  const headers = new Headers(response.headers)
  for (const name of remove) headers.delete(name)
  for (const [name, value] of extra) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  })
}

const measurementHeaders = (usage: D1Usage, cacheOutcome: CacheOutcome): Headers => {
  const headers = new Headers({
    [D1_USAGE]: [
      usage.rowsRead,
      usage.rowsWritten,
      usage.measuredQueries,
      usage.unmeasuredQueries,
    ].join(','),
  })
  if (cacheOutcome !== 'none') headers.set(CACHE_OUTCOME, cacheOutcome)
  return headers
}

/** Credit the object's D1 work and cache outcome to this request's metric, then drop the headers. */
const absorbMeasurement = (response: Response): Response => {
  const usage = response.headers.get(D1_USAGE)?.split(',').map(Number)
  if (usage?.length === 4 && usage.every((value) => Number.isFinite(value) && value >= 0)) {
    mergeD1Usage({
      rowsRead: usage[0] ?? 0,
      rowsWritten: usage[1] ?? 0,
      measuredQueries: usage[2] ?? 0,
      unmeasuredQueries: usage[3] ?? 0,
    })
  }
  const cacheOutcome = response.headers.get(CACHE_OUTCOME)
  if (cacheOutcome === 'hit' || cacheOutcome === 'miss' || cacheOutcome === 'stale')
    recordCacheOutcome(cacheOutcome)
  return withHeaders(response, new Headers(), [D1_USAGE, CACHE_OUTCOME])
}

/** Worker side: hand a live-sync connection to its season's object. */
export const forwardStatusLive = async (
  shard: Fetchable,
  request: Request,
  connection: StatusLiveConnection,
): Promise<Response> => {
  const headers = forwardRequest(request, connection)
  headers.set('sec-websocket-protocol', `caelestis.live.v${connection.protocol}`)
  headers.set(SCOPE, connection.scope)
  headers.set(PROTOCOL, String(connection.protocol))
  headers.set(STATE_VECTOR, flag(connection.stateVector))
  if (connection.lastRevision === null) headers.delete(REVISION)
  else headers.set(REVISION, String(connection.lastRevision))
  return absorbMeasurement(await shard.fetch(new Request(request, { headers })))
}

const readStatusLive = (headers: Headers): StatusLiveConnection | null => {
  const credential = readCredential(headers)
  const scope = headers.get(SCOPE)
  const protocol = headers.get(PROTOCOL)
  const revision = headers.get(REVISION)
  const lastRevision = revision === null ? null : parseWholeNumber(revision)
  const stateVector = readFlag(headers.get(STATE_VECTOR))
  if (
    credential === null ||
    (scope !== 'public' && scope !== 'admin') ||
    (protocol !== '1' && protocol !== '2') ||
    (revision !== null && lastRevision === null) ||
    stateVector === null
  )
    return null
  return { ...credential, scope, protocol: protocol === '2' ? 2 : 1, lastRevision, stateVector }
}

/** Object side: admit a forwarded live-sync connection and report the D1 work it took. */
export const receiveStatusLive = (
  request: Request,
  connect: (connection: StatusLiveConnection) => Promise<LiveAdmission>,
): Promise<Response> =>
  receive(request, readStatusLive, async (connection) => {
    const measured = await measureD1Usage(() => connect(connection))
    if (!measured.success) throw measured.error
    const { response, cacheOutcome } = measured.value
    return withHeaders(response, measurementHeaders(measured.usage, cacheOutcome), [])
  })

/** Worker side: hand a presence connection to its room's object. */
export const forwardPresence = (
  room: Fetchable,
  request: Request,
  connection: PresenceConnection,
): Promise<Response> => {
  const { surface, painter } = connection
  const headers = forwardRequest(request, connection)
  headers.set(SURFACE_KIND, surface.kind)
  headers.delete(ALLIANCE_ID)
  if (surface.allianceId !== null) headers.set(ALLIANCE_ID, String(surface.allianceId))
  headers.set(PAINTER_ID, String(painter.wplaceUserId))
  headers.set(PAINTER_NAME, encodeURIComponent(painter.displayName))
  headers.delete(PUBLISHER_ID)
  if (connection.publisherId !== undefined) headers.set(PUBLISHER_ID, connection.publisherId)
  return room.fetch(new Request(request, { headers }))
}

const readPresence = (headers: Headers): PresenceConnection | null => {
  const credential = readCredential(headers)
  const alliance = headers.get(ALLIANCE_ID)
  const allianceId = alliance === null ? null : parseWholeNumber(alliance)
  const surface = templateSurface(headers.get(SURFACE_KIND), allianceId)
  let displayName: string
  try {
    displayName = decodeURIComponent(headers.get(PAINTER_NAME) ?? '')
  } catch {
    return null
  }
  const painter = { wplaceUserId: parseWholeNumber(headers.get(PAINTER_ID)), displayName }
  const publisherId = headers.get(PUBLISHER_ID)
  if (
    credential === null ||
    surface === null ||
    (alliance !== null && allianceId === null) ||
    !isWorkIdentity(painter) ||
    (publisherId !== null && !isUuidV7(publisherId))
  )
    return null
  return { ...credential, surface, painter, ...(publisherId === null ? {} : { publisherId }) }
}

/** Object side: admit a forwarded presence connection. */
export const receivePresence = (
  request: Request,
  connect: (connection: PresenceConnection) => Promise<Response>,
): Promise<Response> => receive(request, readPresence, connect)
