import type { PainterIdentity, TemplateSurface } from '@caelestis/shared'
import type { Scope } from '../auth/tokens.js'

/** Runtime delivery of persisted region changes. */
export interface PresencePort {
  publishRegions(season: number, surface: TemplateSurface): Promise<void>
}

/** Authenticated metadata passed from the HTTP boundary to a presence transport. */
export interface PresenceConnection {
  readonly season: number
  readonly surface: TemplateSurface
  readonly painter: PainterIdentity
  readonly credentialScope: Scope
  readonly tokenHash: string
  readonly clientHash: string
  readonly anonymous: boolean
  readonly revocable: boolean
  readonly metricClient: string
  readonly metricClientVersion: string
}

export type ConnectPresence = (
  request: Request,
  connection: PresenceConnection,
) => Promise<Response>

/** Count open room sockets without starting presence delivery. */
export type PresenceOnline = (season: number, surface: TemplateSurface) => Promise<number>

/** Pass authenticated metadata to the shared presence room through its internal request boundary. */
export const presenceRequest = (request: Request, connection: PresenceConnection): Request => {
  const { season, surface, painter } = connection
  const headers = new Headers(request.headers)
  headers.set('x-caelestis-season', String(season))
  headers.set('x-caelestis-surface-kind', surface.kind)
  headers.delete('x-caelestis-alliance-id')
  if (surface.allianceId !== null)
    headers.set('x-caelestis-alliance-id', String(surface.allianceId))
  headers.set('x-caelestis-painter-id', String(painter.wplaceUserId))
  headers.set('x-caelestis-painter-name', encodeURIComponent(painter.displayName))
  headers.set('x-caelestis-token-hash', connection.tokenHash)
  headers.set('x-caelestis-client-hash', connection.clientHash)
  headers.set('x-caelestis-credential-scope', connection.credentialScope)
  headers.set('x-caelestis-anonymous', connection.anonymous ? '1' : '0')
  headers.set('x-caelestis-revocable', connection.revocable ? '1' : '0')
  headers.set('x-caelestis-metric-client', connection.metricClient)
  headers.set('x-caelestis-metric-client-version', connection.metricClientVersion)
  return new Request(request, { headers })
}
