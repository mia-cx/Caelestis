import type { TemplateSurface, TileCoord } from '@caelestis/shared'
import type {
  ManifestProjectionInput,
  ManifestProjectionRead,
  VisibilityScope,
} from '../manifest/read-model.js'
import { type IngestTimingSnapshot, ingestTimings } from '../metrics/ingest-timing.js'
import type { SqlStore } from '../ports/index.js'
import type {
  StatusProjectionChange,
  StatusProjectionMutation,
  StatusSnapshotRead,
} from './model.js'
import {
  createSeasonReadModels,
  inMemorySeasonPersistence,
  type SeasonReadModels,
} from './season.js'
import type {
  CommittedTileGeneration,
  PreparedTileGenerationCommit,
  TileGenerationCacheRead,
  TileGenerationOffer,
} from './tile-generation-cache.js'

/** The season status projection: writers repair it after a commit, readers reconcile from it. */
export interface StatusProjectionPort {
  readonly applyCommittedChange: (
    season: number,
    mutation?: StatusProjectionMutation,
  ) => Promise<StatusProjectionChange | null>
  readonly reconcileSnapshot: (
    season: number,
    scope: VisibilityScope,
  ) => Promise<StatusSnapshotRead>
}

/** The season manifest cache, and the wake-up its writers send live manifest subscribers. */
export interface ManifestProjectionPort {
  readonly readManifestProjection: (
    input: ManifestProjectionInput,
  ) => Promise<ManifestProjectionRead>
  /** Metadata-only edits pass `affectsTileCoverage: false` to keep cached tile generations. */
  readonly notifyManifestChange: (
    season: number,
    surface?: TemplateSurface,
    affectsTileCoverage?: boolean,
  ) => Promise<void>
}

/** The cache of current tile generations that lets a repeated offer skip D1. */
export interface TileGenerationPort {
  readonly resolveCurrentTileOffers: (
    season: number,
    scope: VisibilityScope,
    offers: readonly TileGenerationOffer[],
  ) => Promise<TileGenerationCacheRead>
  readonly prepareTileGenerationCommit: (
    season: number,
    tile: TileCoord,
  ) => Promise<PreparedTileGenerationCommit>
  readonly applyCommittedTileGeneration: (
    season: number,
    generation: CommittedTileGeneration,
  ) => Promise<void>
  /** Release a prepared commit that will not apply, so an earlier winner can leave the fence. */
  readonly finishTileGenerationCommit: (
    season: number,
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ) => Promise<void>
}

/** Wake-ups for the season's live connections. */
export interface LiveNotificationPort {
  readonly notifyAlarmChange: (season: number) => Promise<void>
  /** Schedules one coalesced dashboard refresh and resolves before it runs. */
  readonly notifyDashboardChange: (season: number) => Promise<void>
  /** Close every live session of a revoked credential, in this season and every earlier one. */
  readonly closeCredential: (season: number, tokenHash: string) => Promise<void>
  /**
   * Stage timings from wherever this season's live commands run. On Cloudflare that is the
   * season's Durable Object, not the Worker serving the admin route.
   */
  readonly readIngestTimings: (season: number, reset: boolean) => Promise<IngestTimingSnapshot>
}

export interface StatusReadModelPort
  extends StatusProjectionPort,
    ManifestProjectionPort,
    TileGenerationPort,
    LiveNotificationPort {}

/**
 * Run work a reconstructible read model or a live hint owes an authoritative write that already
 * committed. Its failure is logged, never thrown, so it cannot fail that write.
 */
export const bestEffort = async <A>(run: () => Promise<A>): Promise<A | null> => {
  try {
    return await run()
  } catch (error) {
    console.error(error)
    return null
  }
}

/** Process-local read models for hosts with no live connections, such as tests and scripts. */
export class DirectStatusReadModel implements StatusReadModelPort {
  private readonly seasons = new Map<number, SeasonReadModels>()

  constructor(private readonly sql: SqlStore) {}

  private season(season: number): SeasonReadModels {
    const held = this.seasons.get(season)
    if (held !== undefined) return held
    const created = createSeasonReadModels({
      season,
      sql: this.sql,
      persistence: inMemorySeasonPersistence(),
    })
    this.seasons.set(season, created)
    return created
  }

  applyCommittedChange(
    season: number,
    mutation?: StatusProjectionMutation,
  ): Promise<StatusProjectionChange | null> {
    return this.season(season).status.applyCommittedChange(mutation)
  }

  reconcileSnapshot(season: number, scope: VisibilityScope): Promise<StatusSnapshotRead> {
    return this.season(season).status.reconcileSnapshot(scope)
  }

  readManifestProjection(input: ManifestProjectionInput): Promise<ManifestProjectionRead> {
    return this.season(input.season).readManifest(input)
  }

  async notifyManifestChange(
    season: number,
    surface?: TemplateSurface,
    affectsTileCoverage = true,
  ): Promise<void> {
    await this.season(season).invalidateManifest(surface, affectsTileCoverage)
  }

  async resolveCurrentTileOffers(
    season: number,
    scope: VisibilityScope,
    offers: readonly TileGenerationOffer[],
  ): Promise<TileGenerationCacheRead> {
    return this.season(season).resolveTileOffers(scope, offers)
  }

  prepareTileGenerationCommit(
    season: number,
    tile: TileCoord,
  ): Promise<PreparedTileGenerationCommit> {
    return this.season(season).prepareTileCommit(tile)
  }

  applyCommittedTileGeneration(season: number, generation: CommittedTileGeneration): Promise<void> {
    return this.season(season).applyTileGeneration(generation)
  }

  finishTileGenerationCommit(
    season: number,
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ): Promise<void> {
    return this.season(season).finishTileCommit(tile, commit)
  }

  /** Without live connections there is nobody to wake. */
  async notifyAlarmChange(): Promise<void> {}

  /** Without live connections there is nobody to wake. */
  async notifyDashboardChange(): Promise<void> {}

  /** Without live connections there is no session to close. */
  async closeCredential(): Promise<void> {}

  /** Live commands, where any ran, ran in this process. */
  async readIngestTimings(_season: number, reset: boolean): Promise<IngestTimingSnapshot> {
    return ingestTimings.read(reset)
  }
}
