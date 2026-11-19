import type { ServerInfo, TemplateSurface } from '@caelestis/shared'
import { Effect } from 'effect'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import { type StorageError, storage } from '../runtime/errors.js'
import { type ManifestProjectionRead, projectionRead } from './read-model.js'
import { assembleManifestProjection } from './source.js'

export interface ReadManifestInput {
  readonly server: ServerInfo
  readonly season: number
  readonly surface: TemplateSurface
  readonly includeUnpublished: boolean
  readonly ifNoneMatch: readonly string[]
  /** Only the current season is served from the bounded projection cache. */
  readonly cacheable: boolean
}

/** Read one visibility-scoped manifest, from the season's projection cache when it is cacheable. */
export const readManifestProjection = (
  input: ReadManifestInput,
): Effect.Effect<ManifestProjectionRead, StorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    const projection = {
      server: input.server,
      season: input.season,
      surface: input.surface,
      scope: input.includeUnpublished ? 'admin' : 'public',
      ifNoneMatch: input.ifNoneMatch,
    } as const
    if (input.cacheable) {
      const readModel = yield* StatusReadModelService
      return yield* storage('readManifestProjection', () =>
        readModel.readManifestProjection(projection),
      )
    }
    const sql = yield* SqlStoreService
    const manifest = yield* storage('assembleManifest', () =>
      assembleManifestProjection(sql, projection),
    )
    // An uncached read has no projection revision of its own.
    return projectionRead(
      { revision: 1, coverageRevision: 1, cacheOutcome: 'miss', revisionChanged: false },
      manifest,
      input.ifNoneMatch,
    )
  })
