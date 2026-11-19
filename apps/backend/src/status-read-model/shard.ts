import { parseWholeNumber, type TemplateSurface, type TileCoord } from '@caelestis/shared'
import type {
  ManifestProjectionInput,
  ManifestProjectionRead,
  VisibilityScope,
} from '../manifest/read-model.js'
import type { IngestTimingSnapshot } from '../metrics/ingest-timing.js'
import type { StatusCoordinator } from './coordinator.js'
import type {
  StatusProjectionChange,
  StatusProjectionMutation,
  StatusSnapshotRead,
} from './model.js'
import type { StatusReadModelPort } from './port.js'
import type {
  CommittedTileGeneration,
  PreparedTileGenerationCommit,
  TileGenerationCacheRead,
  TileGenerationOffer,
} from './tile-generation-cache.js'

const SHARD_NAME_PREFIX = 'season:'

/** A season coordinator's durable name. Node also keys its state by it. */
export const statusShardName = (season: number): string => `${SHARD_NAME_PREFIX}${season}`

/** The season a shard name was built from, or null when it names no shard. */
export const parseStatusShardName = (name: string): number | null =>
  name.startsWith(SHARD_NAME_PREFIX) ? parseWholeNumber(name.slice(SHARD_NAME_PREFIX.length)) : null

/**
 * The shard reads a Worker request waits on. Behind a Durable Object, each reply carries the D1
 * work it did, so the request's metric counts it.
 */
export const MEASURED_STATUS_METHODS = [
  'applyCommittedChange',
  'reconcileSnapshot',
  'readManifestProjection',
  'resolveCurrentTileOffers',
] as const

/** Every method one season's coordinator serves the hosts that address it. */
export const STATUS_SHARD_METHODS = [
  ...MEASURED_STATUS_METHODS,
  'notifyManifestChange',
  'prepareTileGenerationCommit',
  'applyCommittedTileGeneration',
  'finishTileGenerationCommit',
  'notifyAlarmChange',
  'notifyDashboardChange',
  'closeCredential',
  'readIngestTimings',
  'registerPresenceSurface',
] as const

/** One season's coordinator, in process or behind a Durable Object stub. */
export type StatusShard = Pick<StatusCoordinator<unknown>, (typeof STATUS_SHARD_METHODS)[number]>

/** The read model of a host that runs one status coordinator per season: each call goes to its season's. */
export class CoordinatedStatusReadModel implements StatusReadModelPort {
  constructor(private readonly shard: (season: number) => StatusShard) {}

  registerPresenceSurface(season: number, tokenHash: string, surface: TemplateSurface) {
    return this.shard(season).registerPresenceSurface(tokenHash, surface)
  }

  applyCommittedChange(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> {
    return this.shard(season).applyCommittedChange(mutation)
  }

  reconcileSnapshot(season: number, scope: VisibilityScope): Promise<StatusSnapshotRead> {
    return this.shard(season).reconcileSnapshot(scope)
  }

  readManifestProjection(input: ManifestProjectionInput): Promise<ManifestProjectionRead> {
    return this.shard(input.season).readManifestProjection(input)
  }

  notifyManifestChange(
    season: number,
    surface?: TemplateSurface,
    affectsTileCoverage = true,
  ): Promise<void> {
    return this.shard(season).notifyManifestChange(surface, affectsTileCoverage)
  }

  notifyAlarmChange(season: number): Promise<void> {
    return this.shard(season).notifyAlarmChange()
  }

  notifyDashboardChange(season: number): Promise<void> {
    return this.shard(season).notifyDashboardChange()
  }

  /** Each season's coordinator holds its own sessions, so revocation visits all of them. */
  async closeCredential(currentSeason: number, tokenHash: string): Promise<void> {
    await Promise.all(
      Array.from({ length: currentSeason + 1 }, (_, season) =>
        this.shard(season).closeCredential(tokenHash),
      ),
    )
  }

  resolveCurrentTileOffers(
    season: number,
    scope: VisibilityScope,
    offers: readonly TileGenerationOffer[],
  ): Promise<TileGenerationCacheRead> {
    return this.shard(season).resolveCurrentTileOffers(scope, offers)
  }

  prepareTileGenerationCommit(
    season: number,
    tile: TileCoord,
  ): Promise<PreparedTileGenerationCommit> {
    return this.shard(season).prepareTileGenerationCommit(tile)
  }

  applyCommittedTileGeneration(season: number, generation: CommittedTileGeneration): Promise<void> {
    return this.shard(season).applyCommittedTileGeneration(generation)
  }

  finishTileGenerationCommit(
    season: number,
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ): Promise<void> {
    return this.shard(season).finishTileGenerationCommit(tile, commit)
  }

  readIngestTimings(season: number, reset: boolean): Promise<IngestTimingSnapshot> {
    return this.shard(season).readIngestTimings(reset)
  }
}
