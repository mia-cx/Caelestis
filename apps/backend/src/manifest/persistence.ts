import type { Manifest } from '@caelestis/shared'
import { type CoordinatorStorage, STORAGE_DELETE_BATCH } from '../coordination/database.js'
import type { ManifestReadModelPersistence, PersistedManifestProjection } from './read-model.js'

const MANIFEST_CACHE_INDEX_KEY = 'manifest-read-model:v1:index'
// 128 Ki UTF-16 code units are at most 384 KiB in UTF-8, below the intended 512 KiB ceiling.
const MANIFEST_CACHE_CHUNK_CODE_UNITS = 128 * 1024

interface StoredManifestProjection extends Omit<PersistedManifestProjection, 'manifest'> {
  readonly version: string
  readonly generation: string
  readonly chunks: number
}

interface StoredManifestRetirement {
  readonly generation: string
  readonly chunks: number
}

interface StoredManifestCacheIndex {
  readonly season: number
  readonly revision: number
  /** Absent in indexes written before coverage was tracked, when every revision changed coverage. */
  readonly coverageRevision?: number
  readonly entries: readonly StoredManifestProjection[]
  readonly retired: readonly StoredManifestRetirement[]
}

const coverageOf = (stored: StoredManifestCacheIndex): number =>
  stored.coverageRevision ?? stored.revision

const manifestChunkKey = (generation: string, index: number): string =>
  `manifest-read-model:v1:chunk:${generation}:${index}`

const chunkJsonText = (value: string): readonly string[] => {
  const chunks: string[] = []
  for (let offset = 0; offset < value.length; offset += MANIFEST_CACHE_CHUNK_CODE_UNITS) {
    chunks.push(value.slice(offset, offset + MANIFEST_CACHE_CHUNK_CODE_UNITS))
  }
  return chunks
}

/** Persist each bounded projection independently so one cache write never rewrites every surface. */
export const createChunkedManifestPersistence = (
  storage: CoordinatorStorage,
  season: number,
): ManifestReadModelPersistence => {
  let index: StoredManifestCacheIndex | null = null
  const invalidGenerations = new Set<string>()
  const loadIndex = async () => {
    index ??= (await storage.get<StoredManifestCacheIndex>(MANIFEST_CACHE_INDEX_KEY)) ?? null
    return index
  }
  const deleteRetired = async (retired: readonly StoredManifestRetirement[]) => {
    const keys = retired.flatMap(({ generation, chunks }) =>
      Array.from({ length: chunks }, (_, chunk) => manifestChunkKey(generation, chunk)),
    )
    for (let offset = 0; offset < keys.length; offset += STORAGE_DELETE_BATCH) {
      await storage.delete(keys.slice(offset, offset + STORAGE_DELETE_BATCH))
    }
  }
  return {
    loadCoverageRevision: async () => {
      const stored = await loadIndex()
      return stored?.season === season ? coverageOf(stored) : null
    },
    load: async () => {
      const stored = await loadIndex()
      if (stored === null || stored.season !== season) return null
      const revisions = {
        season: stored.season,
        revision: stored.revision,
        coverageRevision: coverageOf(stored),
      }
      const entries: PersistedManifestProjection[] = []
      for (const entry of stored.entries) {
        const parts: string[] = []
        for (let chunk = 0; chunk < entry.chunks; chunk += 1) {
          const part = await storage.get<string>(manifestChunkKey(entry.generation, chunk))
          if (part === undefined) {
            invalidGenerations.add(entry.generation)
            return { ...revisions, entries: [] }
          }
          parts.push(part)
        }
        try {
          const manifest: unknown = JSON.parse(parts.join(''))
          if (
            typeof manifest !== 'object' ||
            manifest === null ||
            !('version' in manifest) ||
            manifest.version !== entry.version
          ) {
            invalidGenerations.add(entry.generation)
            return { ...revisions, entries: [] }
          }
          entries.push({ ...entry, manifest: manifest as Manifest })
        } catch {
          invalidGenerations.add(entry.generation)
          return { ...revisions, entries: [] }
        }
      }
      return { ...revisions, entries }
    },
    save: async (next) => {
      const previous = await loadIndex()
      const priorEntries = new Map(previous?.entries.map((entry) => [entry.key, entry]) ?? [])
      const reservedGenerations = new Set([
        ...(previous?.entries.map((entry) => entry.generation) ?? []),
        ...(previous?.retired.map((entry) => entry.generation) ?? []),
      ])
      const entries: StoredManifestProjection[] = []
      const newlyRetired: StoredManifestRetirement[] = []
      const repairedGenerations: string[] = []
      for (const projection of next.entries) {
        const prior = priorEntries.get(projection.key)
        if (
          prior?.version === projection.manifest.version &&
          !invalidGenerations.has(prior.generation)
        ) {
          entries.push({
            ...prior,
            configuredServer: projection.configuredServer,
            cachedAt: projection.cachedAt,
            expiresAt: projection.expiresAt,
          })
          priorEntries.delete(projection.key)
          continue
        }
        const generationPrefix = `${next.revision}-${projection.manifest.version}-${encodeURIComponent(projection.key)}:`
        let generationIndex = 0
        while (reservedGenerations.has(`${generationPrefix}${generationIndex}`)) generationIndex++
        const generation = `${generationPrefix}${generationIndex}`
        reservedGenerations.add(generation)
        const chunks = chunkJsonText(JSON.stringify(projection.manifest))
        await storage.transaction(async (transaction) => {
          for (let chunk = 0; chunk < chunks.length; chunk += 1) {
            await transaction.put(manifestChunkKey(generation, chunk), chunks[chunk])
          }
        })
        entries.push({
          key: projection.key,
          configuredServer: projection.configuredServer,
          cachedAt: projection.cachedAt,
          expiresAt: projection.expiresAt,
          serializedBytes: projection.serializedBytes,
          version: projection.manifest.version,
          generation,
          chunks: chunks.length,
        })
        if (prior !== undefined) {
          newlyRetired.push({ generation: prior.generation, chunks: prior.chunks })
          if (invalidGenerations.has(prior.generation)) repairedGenerations.push(prior.generation)
          priorEntries.delete(projection.key)
        }
      }
      newlyRetired.push(
        ...[...priorEntries.values()].map(({ generation, chunks }) => ({ generation, chunks })),
      )
      const retired = [...(previous?.retired ?? []), ...newlyRetired]
      const published: StoredManifestCacheIndex = {
        season: next.season,
        revision: next.revision,
        coverageRevision: next.coverageRevision,
        entries,
        retired,
      }
      await storage.put(MANIFEST_CACHE_INDEX_KEY, published)
      index = published
      for (const generation of repairedGenerations) invalidGenerations.delete(generation)
      if (retired.length > 0) {
        try {
          await deleteRetired(retired)
          const cleaned = { ...published, retired: [] }
          await storage.put(MANIFEST_CACHE_INDEX_KEY, cleaned)
          index = cleaned
        } catch (error) {
          // The new index is already durable. Retired chunks are reconstructible garbage and the
          // next save retries their cleanup; they must not suppress the invalidation or live event.
          console.error(error)
        }
      }
    },
  }
}
