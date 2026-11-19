import {
  isUuidV7,
  isWorkIdentity,
  LIVE_PROTOCOL_V1,
  LIVE_PROTOCOL_V2,
  PRESENCE_PROTOCOL_V1,
  parseWholeNumber,
} from '@caelestis/shared'
import { Effect } from 'effect'
import { type Context, Hono } from 'hono'
import {
  type AuthOptions,
  authenticateRequest,
  type Caller,
  requireScopeEffect,
} from '../auth/middleware.js'
import { hashToken } from '../auth/tokens.js'
import { normalizeMetricClientIdentity } from '../metrics/request-metrics.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { parseSurface } from './params.js'
import type { TelemetryRouteOptions } from './telemetry.js'

const LIVE_PROTOCOLS = [LIVE_PROTOCOL_V2, LIVE_PROTOCOL_V1] as const
/** Browsers cannot set headers on a websocket, so clients carry a bearer token as a subprotocol. */
const LIVE_AUTH_PREFIX = 'caelestis.auth.b64.'

const decodeLiveCredential = (encoded: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    const token = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    return token.length === 0 ? null : token
  } catch {
    return null
  }
}

/** The protocol a websocket asked for and the credential it carries, or null when malformed. */
const liveAuthorization = (
  header: string | undefined,
  authorizationHeader: string | undefined,
  presence: boolean,
): { readonly authorization?: string; readonly protocol: 1 | 2 } | null => {
  if (header === undefined) return null
  const protocols = header.split(',').map((protocol) => protocol.trim())
  const selected = presence
    ? protocols.find((protocol) => protocol === PRESENCE_PROTOCOL_V1)
    : LIVE_PROTOCOLS.find((protocol) => protocols.includes(protocol))
  if (selected === undefined) return null
  const protocol = selected === LIVE_PROTOCOL_V2 ? 2 : 1
  const credentials = protocols.filter((candidate) => candidate.startsWith(LIVE_AUTH_PREFIX))
  if (credentials.length > 1) return null
  const credential = credentials[0]
  if (credential === undefined) {
    return authorizationHeader === undefined
      ? { protocol }
      : { authorization: authorizationHeader, protocol }
  }
  const token = decodeLiveCredential(credential.slice(LIVE_AUTH_PREFIX.length))
  return token === null ? null : { authorization: `Bearer ${token}`, protocol }
}

const metricClientOf = (c: Context) =>
  normalizeMetricClientIdentity(
    c.req.query('client') ?? 'unknown',
    c.req.query('clientVersion') ?? 'unknown',
  )

/** Anonymous readers share one token, so their client id tells their connections apart. */
const isAnonymous = (caller: Caller): boolean => caller.token === null && caller.scope === 'read'

const NOT_SERVED = 'season is not served by this live endpoint'

/** Websocket endpoints for presence and live status. They serve the current season only. */
export const createTelemetryLiveRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  options: TelemetryRouteOptions,
) => {
  const routes = new Hono()
  const servedSeason = (c: Context): number | null => {
    const season = parseWholeNumber(c.req.query('season'))
    return season === options.currentSeason ? season : null
  }

  /** Check the upgrade, authenticate the credential its subprotocol carries, then connect. */
  const upgrade =
    (
      presence: boolean,
      connect: (c: Context, caller: Caller, protocol: 1 | 2) => Promise<Response>,
    ) =>
    async (c: Context) => {
      if (c.req.header('upgrade')?.toLowerCase() !== 'websocket')
        return c.json({ error: 'websocket upgrade required' }, 426)
      const credentials = liveAuthorization(
        c.req.header('sec-websocket-protocol'),
        c.req.header('authorization'),
        presence,
      )
      if (credentials === null) return c.json({ error: 'invalid websocket protocol' }, 400)
      return runBackendHttp(
        c,
        runtime,
        Effect.flatMap(authenticateRequest(credentials.authorization, auth, 'read'), (caller) =>
          Effect.promise(() => connect(c, caller, credentials.protocol)),
        ),
        (response) => response,
      )
    }

  routes.get('/presence/online', requireScopeEffect(runtime, auth, 'read'), async (c) => {
    c.header('cache-control', 'no-store')
    if (options.connectPresence === undefined || options.presenceOnline === undefined)
      return c.json({ error: 'not found' }, 404)
    const season = servedSeason(c)
    if (season === null) return c.json({ error: NOT_SERVED }, 404)
    const surface = parseSurface(c.req.query('surface'), c.req.query('allianceId'))
    if (surface === null) return c.json({ error: 'invalid drawing surface' }, 400)
    return c.json({ online: await options.presenceOnline(season, surface) })
  })

  routes.get(
    '/presence',
    upgrade(true, async (c, caller) => {
      if (options.connectPresence === undefined) return c.json({ error: 'not found' }, 404)
      const season = servedSeason(c)
      if (season === null) return c.json({ error: NOT_SERVED }, 404)
      const surface = parseSurface(c.req.query('surface'), c.req.query('allianceId'))
      const painter = {
        wplaceUserId: parseWholeNumber(c.req.query('painterId')),
        displayName: c.req.query('painterName'),
      }
      if (surface === null || !isWorkIdentity(painter))
        return c.json({ error: 'invalid drawing surface or painter identity' }, 400)
      const clientId = c.req.query('clientId')
      if (clientId === undefined || !isUuidV7(clientId))
        return c.json({ error: 'clientId must be a UUID' }, 400)
      const clientHash = await hashToken(`${caller.tokenHash}\u0000${clientId}`)
      const publisherId = c.req.query('publisherId')
      if (publisherId !== undefined && !isUuidV7(publisherId))
        return c.json({ error: 'publisherId must be a UUID' }, 400)
      const metricClient = metricClientOf(c)
      return options.connectPresence(c.req.raw, {
        season,
        surface,
        painter,
        credentialScope: caller.scope,
        tokenHash: caller.tokenHash,
        clientHash,
        ...(publisherId === undefined ? {} : { publisherId }),
        anonymous: isAnonymous(caller),
        revocable: caller.token !== null,
        metricClient: metricClient.client,
        metricClientVersion: metricClient.clientVersion,
      })
    }),
  )

  routes.get(
    '/live',
    upgrade(false, async (c, caller, protocol) => {
      if (options.connectStatusLive === undefined) return c.json({ error: 'not found' }, 404)
      const season = servedSeason(c)
      if (season === null) return c.json({ error: NOT_SERVED }, 404)
      const requestedScope = c.req.query('scope')
      const scope =
        requestedScope === 'public' || (requestedScope === 'admin' && caller.scope === 'admin')
          ? requestedScope
          : null
      if (scope === null) return c.json({ error: 'visibility scope mismatch' }, 403)
      const lastRevisionRaw = c.req.query('revision')
      const lastRevision = lastRevisionRaw === undefined ? null : parseWholeNumber(lastRevisionRaw)
      if (lastRevisionRaw !== undefined && lastRevision === null) {
        return c.json({ error: 'revision must be a non-negative integer' }, 400)
      }
      const anonymous = isAnonymous(caller)
      let clientHash = caller.tokenHash
      if (anonymous) {
        const clientId = c.req.query('clientId')
        if (clientId === undefined || !isUuidV7(clientId)) {
          return c.json({ error: 'clientId must be a UUID' }, 400)
        }
        clientHash = await hashToken(`${caller.tokenHash}\u0000${clientId}`)
      }
      const metricClient = metricClientOf(c)
      return options.connectStatusLive(c.req.raw, {
        season,
        scope,
        credentialScope: caller.scope,
        tokenHash: caller.tokenHash,
        clientHash,
        anonymous,
        revocable: caller.token !== null,
        lastRevision,
        metricClient: metricClient.client,
        metricClientVersion: metricClient.clientVersion,
        protocol,
        stateVector: c.req.query('stateVector') === '1',
      })
    }),
  )

  return routes
}
