import { millis } from '@caelestis/shared'
import { Effect } from 'effect'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import { ConflictError, NotFoundError, StorageError, storage } from '../runtime/errors.js'
import { publishManifestChange } from '../status-read-model/port.js'
import { TagConflictError, type TagMutation } from './store.js'

/** Read the reusable catalog and, optionally, one template or folder's assignments. */
export const readTags = (templateId?: string, folderId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* Effect.tryPromise({
      try: async () => {
        const tags = await sql.listTags()
        if (folderId !== undefined) {
          if ((await sql.readNode(folderId)) === null)
            throw new NotFoundError({ message: 'Folder no longer exists.' })
          return { tags, selected: await sql.listNodeTagIds(folderId) }
        }
        if (templateId === undefined) return { tags, selected: [] as string[] }
        const template = await sql.readTemplate(templateId)
        if (template === null) throw new NotFoundError({ message: 'Template no longer exists.' })
        return { tags, selected: await sql.listTemplateTagIds(templateId) }
      },
      catch: (cause) =>
        cause instanceof NotFoundError ? cause : new StorageError({ operation: 'readTags', cause }),
    })
  })

/** Commit authoritative metadata before notifying every affected manifest scope. */
export const mutateTag = (mutation: TagMutation, currentSeason: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const readModel = yield* StatusReadModelService
    const scopes = yield* storage('listTagScopes', () => sql.listTagScopes())
    const changed = yield* Effect.tryPromise({
      try: () => sql.mutateTag(mutation, millis(Date.now())),
      catch: (cause) =>
        cause instanceof TagConflictError
          ? new ConflictError({ message: cause.message })
          : new StorageError({ operation: 'mutateTag', cause }),
    })
    if (!changed)
      return yield* Effect.fail(
        new NotFoundError({ message: 'Tag, template, or folder no longer exists.' }),
      )
    yield* Effect.promise(() =>
      Promise.all(
        [...new Set([currentSeason, ...scopes.map(({ season }) => season)])].map((season) =>
          publishManifestChange(readModel, season, undefined, false),
        ),
      ),
    )
    return { id: mutation.id }
  })
