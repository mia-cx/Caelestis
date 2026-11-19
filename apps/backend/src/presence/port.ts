import type { PainterIdentity, Scope, TemplateSurface } from '@caelestis/shared'
import type { IngestTimingSnapshot } from '../telemetry/ingest-timing.js'

/** Runtime delivery of persisted region changes. */
export interface PresencePort {
  publishRegions(season: number, surface: TemplateSurface): Promise<void>
  /** Reach a room's own timing collector when it lives in another isolate. */
  readIngestTimings?(
    season: number,
    surface: TemplateSurface,
    reset: boolean,
  ): Promise<IngestTimingSnapshot>
}

/** Authenticated metadata passed from the HTTP boundary to a presence transport. */
export interface PresenceConnection {
  readonly publisherId?: string
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
