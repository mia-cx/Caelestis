import type { TemplateStatus } from '@caelestis/shared'
import { type CoordinatorStorage, STORAGE_DELETE_BATCH } from '../coordination/database.js'
import type { VisibilityScope } from '../manifest/read-model.js'
import {
  byTemplateId,
  type PersistedStatusReadModel,
  type StatusReadModelPersistence,
  sameStatus,
  scopeTemplates,
} from './model.js'

const STATUS_PREFIX = 'status-read-model:v3:'
const STATUS_MANIFEST_KEY = `${STATUS_PREFIX}manifest`
/** The whole-projection chunks written before each template had its own key. */
const LEGACY_STATUS_PREFIX = 'status-read-model:v2:'

interface StoredStatusManifest {
  readonly season: number
  readonly revision: number
  readonly reconciledAt: number
}

const STATUS_SCOPES = ['public', 'admin'] as const

const statusTemplatePrefix = (scope: VisibilityScope): string => `${STATUS_PREFIX}${scope}:`

/**
 * Atomic persistence for a season projection that keeps each template's status under its own key,
 * so a commit writes only the templates it changed rather than the whole season.
 */
export const createKeyedStatusPersistence = (
  storage: CoordinatorStorage,
  season: number,
): StatusReadModelPersistence => {
  // The projection storage holds, as the objects last loaded or saved.
  let saved: PersistedStatusReadModel | null = null
  const listScope = async (scope: VisibilityScope) =>
    [
      ...(await storage.list<TemplateStatus>({ prefix: statusTemplatePrefix(scope) })).values(),
    ].sort(byTemplateId)

  return {
    load: async () => {
      const stored = await storage.get<StoredStatusManifest>(STATUS_MANIFEST_KEY)
      if (stored === undefined) {
        // The projection is reconstructible, so an older layout is dropped and rebuilt.
        const legacy = [...(await storage.list({ prefix: LEGACY_STATUS_PREFIX })).keys()]
        for (let offset = 0; offset < legacy.length; offset += STORAGE_DELETE_BATCH)
          await storage.delete(legacy.slice(offset, offset + STORAGE_DELETE_BATCH))
        return null
      }
      if (stored.season !== season) return null
      const [publicTemplates, adminTemplates] = await Promise.all([
        listScope('public'),
        listScope('admin'),
      ])
      saved = { ...stored, publicTemplates, adminTemplates }
      return saved
    },
    save: async (next) => {
      // Without a loaded projection, compare against whatever templates storage still holds.
      const previous = saved ?? {
        ...next,
        publicTemplates: await listScope('public'),
        adminTemplates: await listScope('admin'),
      }
      await storage.transaction(async (transaction) => {
        for (const scope of STATUS_SCOPES) {
          const held = new Map(
            scopeTemplates(previous, scope).map((status) => [status.templateId, status]),
          )
          for (const status of scopeTemplates(next, scope)) {
            const before = held.get(status.templateId)
            held.delete(status.templateId)
            if (sameStatus(before, status)) continue
            await transaction.put(`${statusTemplatePrefix(scope)}${status.templateId}`, status)
          }
          for (const templateId of held.keys())
            await transaction.delete(`${statusTemplatePrefix(scope)}${templateId}`)
        }
        await transaction.put(STATUS_MANIFEST_KEY, {
          season: next.season,
          revision: next.revision,
          reconciledAt: next.reconciledAt,
        } satisfies StoredStatusManifest)
      })
      saved = next
    },
  }
}
