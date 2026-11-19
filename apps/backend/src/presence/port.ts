import {
  type PainterIdentity,
  parseTemplateSurfaceKey,
  parseWholeNumber,
  type Scope,
  type TemplateSurface,
  templateSurfaceKey,
} from '@caelestis/shared'
import { type IngestTimingSnapshot, IngestTimings } from '../metrics/ingest-timing.js'
import { NotFoundError } from '../runtime/errors.js'

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

/** The presence rooms, one per season and drawing surface, as the app reaches them. */
export interface PresencePort {
  /** Deliver persisted region changes to the room's sockets. */
  publishRegions(season: number, surface: TemplateSurface): Promise<void>
  /**
   * The room's own timing collector. Every host gives each room its own, as a Durable Object's
   * isolate does, so the admin endpoint reads the same room on every host.
   */
  readIngestTimings(
    season: number,
    surface: TemplateSurface,
    reset: boolean,
  ): Promise<IngestTimingSnapshot>
  /** Count open room sockets without starting presence delivery. */
  online(season: number, surface: TemplateSurface): Promise<number>
  connect(request: Request, connection: PresenceConnection): Promise<Response>
}

/** A room's identity: the season and drawing surface it serves. */
export interface PresenceRoomId {
  readonly season: number
  readonly surface: TemplateSurface
}

/** One room, in process or behind a Durable Object stub. */
export interface PresenceRoom {
  publishRegions(): Promise<void>
  readIngestTimings(reset: boolean): IngestTimingSnapshot | Promise<IngestTimingSnapshot>
  online(): Promise<number>
  closeCredential(tokenHash: string): Promise<void>
  /** `request` is what a Durable Object hop forwards; an in-process room needs only the connection. */
  connect(connection: PresenceConnection, request: Request): Promise<Response>
}

export type PresenceRooms = (season: number, surface: TemplateSurface) => PresenceRoom

const notServed = (): Promise<never> => Promise.reject(new NotFoundError({ message: 'not found' }))

/** A host without live sockets, such as tests and scripts: nothing to deliver, nothing to join. */
export const noPresence: PresencePort = {
  publishRegions: async () => {},
  readIngestTimings: async () => new IngestTimings().snapshot(),
  online: notServed,
  connect: notServed,
}

/** A room's durable name: its season and surface. Node also keys its state by it. */
export const presenceRoomName = (season: number, surface: TemplateSurface): string =>
  `${season}:${templateSurfaceKey(surface)}`

/** The season and surface a room name was built from, or null when it names no room. */
export const parsePresenceRoomName = (name: string): PresenceRoomId | null => {
  const separator = name.indexOf(':')
  const season = parseWholeNumber(name.slice(0, separator))
  const surface = parseTemplateSurfaceKey(name.slice(separator + 1))
  return season !== null && surface !== null ? { season, surface } : null
}
