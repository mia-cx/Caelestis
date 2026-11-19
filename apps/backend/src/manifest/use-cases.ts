import type { ServerInfo, TemplateSurface } from '@caelestis/shared'
import { Effect } from 'effect'
import { type SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import { type StorageError, storage } from '../runtime/errors.js'
import { resolveServerInfo } from '../server/use-cases.js'
import { assembleManifestEffect } from './assemble.js'
import { type ManifestProjectionRead, matchesIfNoneMatch } from './read-model.js'

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
    if (input.cacheable) {
      const readModel = yield* StatusReadModelService
      return yield* storage('readManifestProjection', () =>
        readModel.readManifestProjection({
          server: input.server,
          season: input.season,
          surface: input.surface,
          scope: input.includeUnpublished ? 'admin' : 'public',
          ifNoneMatch: input.ifNoneMatch,
        }),
      )
    }
    const manifest = yield* assembleManifestEffect({
      server: yield* resolveServerInfo(input.server),
      season: input.season,
      surface: input.surface,
      includeUnpublished: input.includeUnpublished,
    })
    // An uncached read has no projection revision of its own.
    const base = {
      version: manifest.version,
      revision: 1,
      coverageRevision: 1,
      cacheOutcome: 'miss' as const,
      revisionChanged: false,
    }
    return matchesIfNoneMatch(input.ifNoneMatch, manifest.version)
      ? { ...base, notModified: true as const }
      : { ...base, notModified: false as const, manifest }
  })
