import {
  type Millis,
  type PixelBounds,
  type Seconds,
  type TemplateStatus,
  type TileCoord,
  type TileHistoryFrame,
  WORLD_TILES,
} from '@caelestis/shared'
import type { ManifestTileRecord } from '../../templates/store.js'
import { TILE_HISTORY_RESOLUTIONS } from './ladder.js'

/** One current template chunk affected by a canvas tile observation or paint event. */
export interface TelemetryTarget extends ManifestTileRecord {
  readonly bbox: PixelBounds
  readonly finished: boolean
  readonly published: boolean
  readonly totalPixels: number
  readonly colourTotals?: readonly { readonly index: number; readonly total: number }[]
}

export interface TileObservation {
  readonly season: number
  readonly tile: TileCoord
  readonly hash: string
  readonly observedAt: Millis
  readonly reportedAt: Seconds
  readonly reportedWithToken: string
  readonly reportedByUserId: number
}

export type LatestTileObservation = Pick<TileObservation, 'season' | 'tile' | 'hash' | 'observedAt'>

export interface TemplateTileStatusRecord {
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly colours?: readonly {
    readonly index: number
    readonly correct: number
    readonly wrong: number
    readonly blank: number
    readonly total: number
  }[]
  readonly observedAt: Millis
}

/** Counts for immutable artwork and canvas bytes, independent of current status. */
export interface TileMeasurement {
  readonly hash: string
  readonly correct: number
  readonly wrong: number
  readonly blank: number
}

export interface MeasuredTileFrame {
  readonly tileX: number
  readonly tileY: number
  readonly bucketStart: Seconds
  readonly hash: string
  readonly correct: number | null
  readonly wrong: number | null
}

export interface TemplateTileStatusChange {
  readonly published: boolean
  readonly totalPixels: number
  readonly colourTotals?: readonly { readonly index: number; readonly total: number }[]
  readonly previous: TemplateTileStatusRecord | null
  readonly current: TemplateTileStatusRecord
  /** Template-wide correct count read before this tile changed, in the same transaction. */
  readonly previousTemplateCorrect: number
  readonly previousTemplateObservedAt: Millis
}

/** One observation to record against the blob reservation that holds its bytes. */
export interface TileObservationCommitRequest {
  readonly reservationId: string
  readonly now: Millis
  readonly observation: TileObservation
  readonly statuses: readonly TemplateTileStatusRecord[]
  readonly recordHistory: boolean
  /** A server fetch outranks a reporter's row even when a client clock put it in the future. */
  readonly authoritative: boolean
  /** Whether the committing reporter may still target an unpublished current version. */
  readonly includeUnpublished: boolean
}

export interface TileObservationCommit {
  /** Revision advanced in the same transaction as the accepted tile-status rows. */
  readonly revision: number | null
  readonly statusChanges: readonly TemplateTileStatusChange[]
  /** Present only when this commit became the current canvas generation. */
  readonly current: (LatestTileObservation & { readonly commitOrder: number }) | null
}

export interface TileHistoryQuery {
  readonly season: number
  readonly tile: TileCoord
  /** A `TILE_HISTORY_RESOLUTIONS` tier — 0 reads the raw observations. */
  readonly resolution: number
  readonly fromSeconds: Seconds
  readonly toSeconds: Seconds
}

export const assertValidTileHistoryQuery = (query: TileHistoryQuery): void => {
  if (!TILE_HISTORY_RESOLUTIONS.includes(query.resolution)) {
    throw new Error(`readTileHistory resolution ${query.resolution} is not a ladder tier`)
  }
  const { x, y } = query.tile
  if (![x, y].every(Number.isSafeInteger) || x < 0 || x >= WORLD_TILES || y < 0 || y >= WORLD_TILES)
    throw new Error(`readTileHistory tile ${x}/${y} is outside the canvas`)
}

/** Canvas tiles as observed: current generation, history, and the template status it drives. */
export interface TileStore {
  listTelemetryTargets(
    season: number,
    tile: TileCoord,
    includeUnpublished: boolean,
  ): Promise<readonly TelemetryTarget[]>

  readLatestTile(season: number, tile: TileCoord): Promise<LatestTileObservation | null>

  /**
   * Record an observation in one atomic batch: verify its blob reservation and activate the object,
   * then write raw history, the current canvas generation, template statuses, measurements, alarm
   * evidence for authoritative fetches, and the projection revision. Null means the reservation
   * expired or a deletion fence won first; nothing was recorded.
   */
  commitTileObservation(commit: TileObservationCommitRequest): Promise<TileObservationCommit | null>

  /**
   * The latest accepted observation of every observed tile in a season, ordered by x then y.
   *
   * Unbounded on purpose: only observed tiles have rows, and reporters plus the scheduled capture
   * plan stay near templates, so this is thousands of rows at the outside, not four million.
   */
  listLatestTiles(season: number): Promise<readonly LatestTileObservation[]>

  /**
   * One tile's timelapse frames at one `tile_history` tier over a half-open range: one frame per
   * bucket, chosen by `foldTileFrames`, in bucket order.
   */
  readTileHistory(query: TileHistoryQuery): Promise<readonly TileHistoryFrame[]>

  /** Fold the SQL history for one touched tile. Physical blob GC needs a separately safe protocol. */
  foldTileHistory(season: number, tile: TileCoord, now: Seconds): Promise<void>

  readTemplateStatuses(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly TemplateStatus[]>

  /** Read the revision that must fence an authoritative projection rebuild. */
  readStatusProjectionRevision(season: number): Promise<number>

  /**
   * Publish fingerprints only if no tile-status commit advanced the revision since the source read.
   * Null asks the caller to reread rather than publishing mixed-revision data.
   */
  commitStatusProjectionRevision(
    season: number,
    expectedRevision: number,
    retainRevision: boolean,
    publicFingerprint: string,
    adminFingerprint: string,
  ): Promise<number | null>

  /** Earliest native observation bucket across this version's tiles and all retained tiers. */
  readFirstTemplateObservation(versionId: string): Promise<Seconds | null>

  /** Read winning frames, optionally excluding observations outside the artwork's active lifetime. */
  readTemplateProgressFrames(
    versionId: string,
    from: Seconds,
    to: Seconds,
    resolution: number,
    lifetime?: { readonly fromSeconds: Seconds; readonly toSeconds: Seconds },
  ): Promise<readonly MeasuredTileFrame[]>

  /** Latest retained canvas frame per tile as of this time, with cached counts for this artwork. */
  readTemplateProgressAt(versionId: string, at: Seconds): Promise<readonly MeasuredTileFrame[]>

  /** Insert missing measurements, preserving existing counts and all live/placement records. */
  writeTileMeasurements(
    versionId: string,
    tile: TileCoord,
    measurements: readonly TileMeasurement[],
  ): Promise<void>
}
