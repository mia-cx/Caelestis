import type { TemplateSurface, TileCoord } from '@caelestis/shared'
import type { ManifestProjectionInput, ManifestProjectionRead } from '../manifest/read-model.js'
import type { IngestTimingSnapshot } from '../metrics/ingest-timing.js'
import type { StatusCoordinator } from '../status-coordinator.js'
import type {
  StatusProjectionChange,
  StatusProjectionMutation,
  StatusSnapshotRead,
  StatusVisibilityScope,
} from '../status-read-model/model.js'
import type { StatusReadModelPort } from '../status-read-model/port.js'
import type {
  CommittedTileGeneration,
  PreparedTileGenerationCommit,
  TileGenerationCacheRead,
  TileGenerationOffer,
} from '../status-read-model/tile-generation-cache.js'

/** A season coordinator's durable name. Node also keys its state by it. */
export const statusShardName = (season: number): string => `season:${season}`

/** One season's coordinator, in process or behind a Durable Object stub. */
export type StatusShard = Pick<
  StatusCoordinator<unknown>,
  | 'applyCommittedChange'
  | 'reconcileSnapshot'
  | 'readManifestProjection'
  | 'notifyManifestChange'
  | 'resolveCurrentTileOffers'
  | 'prepareTileGenerationCommit'
  | 'applyCommittedTileGeneration'
  | 'finishTileGenerationCommit'
  | 'notifyAlarmChange'
  | 'notifyDashboardChange'
  | 'closeCredential'
  | 'readIngestTimings'
  | 'registerPresenceSurface'
>

/** The read model of a host that runs one status coordinator per season. */
export class CoordinatedStatusReadModel implements StatusReadModelPort {
  constructor(
    private readonly shard: (season: number) => StatusShard,
    /** Absent only for the alarm watcher, which is what scheduling alarms wakes. */
    private readonly scheduleAlarms?: () => Promise<void>,
  ) {}

  registerPresenceSurface(season: number, tokenHash: string, surface: TemplateSurface) {
    return this.shard(season).registerPresenceSurface(season, tokenHash, surface)
  }

  applyCommittedChange(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> {
    return this.shard(season).applyCommittedChange(season, mutation)
  }

  reconcileSnapshot(season: number, scope: StatusVisibilityScope): Promise<StatusSnapshotRead> {
    return this.shard(season).reconcileSnapshot(season, scope)
  }

  readManifestProjection(input: ManifestProjectionInput): Promise<ManifestProjectionRead> {
    return this.shard(input.season).readManifestProjection(input)
  }

  notifyManifestChange(
    season: number,
    surface?: TemplateSurface,
    affectsTileCoverage = true,
  ): Promise<void> {
    return this.shard(season).notifyManifestChange(season, surface, affectsTileCoverage)
  }

  async notifyAlarmChange(season: number): Promise<void> {
    await this.shard(season).notifyAlarmChange(season)
    await this.scheduleAlarms?.()
  }

  notifyDashboardChange(season: number): Promise<void> {
    return this.shard(season).notifyDashboardChange(season)
  }

  /** Each season's coordinator holds its own sessions, so revocation visits all of them. */
  async closeCredential(currentSeason: number, tokenHash: string): Promise<void> {
    await Promise.all(
      Array.from({ length: currentSeason + 1 }, (_, season) =>
        this.shard(season).closeCredential(season, tokenHash),
      ),
    )
  }

  resolveCurrentTileOffers(
    season: number,
    scope: StatusVisibilityScope,
    offers: readonly TileGenerationOffer[],
  ): Promise<TileGenerationCacheRead> {
    return this.shard(season).resolveCurrentTileOffers(season, scope, offers)
  }

  prepareTileGenerationCommit(
    season: number,
    tile: TileCoord,
  ): Promise<PreparedTileGenerationCommit> {
    return this.shard(season).prepareTileGenerationCommit(season, tile)
  }

  applyCommittedTileGeneration(season: number, generation: CommittedTileGeneration): Promise<void> {
    return this.shard(season).applyCommittedTileGeneration(season, generation)
  }

  finishTileGenerationCommit(
    season: number,
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ): Promise<void> {
    return this.shard(season).finishTileGenerationCommit(season, tile, commit)
  }

  readIngestTimings(season: number, reset: boolean): Promise<IngestTimingSnapshot> {
    return this.shard(season).readIngestTimings(reset)
  }
}
