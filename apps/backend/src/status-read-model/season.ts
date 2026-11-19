import type { TemplateSurface, TileCoord } from '@caelestis/shared'
import {
  createSeasonManifestReadModel,
  type ManifestProjectionInput,
  type ManifestProjectionRead,
  type ManifestReadModelPersistence,
  type PersistedManifestReadModel,
} from '../manifest/read-model.js'
import { assembleManifestProjection } from '../manifest/source.js'
import type { SqlStore } from '../ports/index.js'
import {
  createSeasonStatusReadModel,
  type PersistedStatusReadModel,
  type SeasonStatusReadModel,
  type StatusReadModelPersistence,
  type StatusVisibilityScope,
} from './model.js'
import {
  type CommittedTileGeneration,
  createTileGenerationCache,
  type PreparedTileGenerationCommit,
  type TileGenerationCacheRead,
  type TileGenerationOffer,
} from './tile-generation-cache.js'

export interface SeasonReadModelPersistence {
  readonly status: StatusReadModelPersistence
  readonly manifest: ManifestReadModelPersistence
}

/** One season's status projection, manifest cache and tile-generation cache, kept in step. */
export interface SeasonReadModels {
  readonly status: SeasonStatusReadModel
  /** Read a manifest; a new revision also moves the tile cache to its coverage. */
  readonly readManifest: (input: ManifestProjectionInput) => Promise<ManifestProjectionRead>
  /** Drop cached manifests and return the new revision. */
  readonly invalidateManifest: (
    surface: TemplateSurface | undefined,
    affectsTileCoverage: boolean,
  ) => Promise<number>
  /** Current unexpired manifest version, or null when an authoritative read is required. */
  readonly knownManifestVersion: (
    scope: StatusVisibilityScope,
    surface: TemplateSurface,
  ) => Promise<string | null>
  readonly resolveTileOffers: (
    scope: StatusVisibilityScope,
    offers: readonly TileGenerationOffer[],
  ) => TileGenerationCacheRead
  readonly prepareTileCommit: (tile: TileCoord) => Promise<PreparedTileGenerationCommit>
  readonly applyTileGeneration: (generation: CommittedTileGeneration) => Promise<void>
  readonly finishTileCommit: (
    tile: TileCoord,
    commit: PreparedTileGenerationCommit,
  ) => Promise<void>
}

/** Persistence that lives as long as the process, for hosts without durable projection storage. */
export const inMemorySeasonPersistence = (): SeasonReadModelPersistence => {
  let status: PersistedStatusReadModel | null = null
  let manifest: PersistedManifestReadModel | null = null
  return {
    status: {
      load: async () => status,
      save: async (next) => {
        status = next
      },
    },
    manifest: {
      load: async () => manifest,
      loadCoverageRevision: async () => manifest?.coverageRevision ?? null,
      save: async (next) => {
        manifest = next
      },
    },
  }
}

/**
 * Build one season's read models over D1. Tile generations are valid for one manifest coverage
 * revision: the cache's coverage token is derived from it, so any coverage change, whether this
 * process or another wrote it, retires every cached generation.
 */
export const createSeasonReadModels = (options: {
  readonly season: number
  readonly sql: SqlStore
  readonly persistence: SeasonReadModelPersistence
}): SeasonReadModels => {
  const { season, sql, persistence } = options
  const status = createSeasonStatusReadModel({
    season,
    source: {
      read: (requestedSeason, scope) =>
        sql.readTemplateStatuses(requestedSeason, scope === 'admin'),
    },
    persistence: persistence.status,
    revisions: {
      current: (requestedSeason) => sql.readStatusProjectionRevision(requestedSeason),
      commit: (...args) => sql.commitStatusProjectionRevision(...args),
    },
  })
  const manifest = createSeasonManifestReadModel({
    season,
    source: (input) => assembleManifestProjection(sql, input),
    persistence: persistence.manifest,
  })
  const tiles = createTileGenerationCache()
  let coverageRevision = 0
  const cover = (revision: number): void => {
    if (revision <= coverageRevision) return
    coverageRevision = revision
    tiles.synchronizeCoverageToken(`manifest:${revision}`)
  }
  const loadCoverage = async (): Promise<void> => cover(await manifest.coverageRevision())

  return {
    status,
    readManifest: async (input) => {
      const read = await manifest.read(input)
      if (read.revisionChanged) cover(read.coverageRevision)
      return read
    },
    invalidateManifest: async (surface, affectsTileCoverage) => {
      const revision = await manifest.invalidate(surface, affectsTileCoverage)
      await loadCoverage()
      return revision
    },
    knownManifestVersion: manifest.knownVersion,
    resolveTileOffers: (scope, offers) => tiles.resolve(scope, offers),
    prepareTileCommit: async (tile) => {
      await loadCoverage()
      return tiles.prepare(tile)
    },
    applyTileGeneration: async (generation) => {
      // A generation without a prepared commit carries no fence to check coverage against.
      if (generation.commitToken !== undefined) await loadCoverage()
      tiles.apply(generation)
    },
    finishTileCommit: async (tile, commit) => {
      await loadCoverage()
      tiles.finish(tile, commit)
    },
  }
}
