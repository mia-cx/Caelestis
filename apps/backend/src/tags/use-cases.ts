import { millis } from '@caelestis/shared'
import { Effect } from 'effect'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import { fromPort, NotFoundError, storage } from '../runtime/errors.js'
import { publishManifestChange } from '../status-read-model/port.js'
import type { TagMutation } from './store.js'

/** The reusable catalog and, optionally, one template's or folder's assignments. */
export const readTags = (templateId?: string, folderId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const tags = yield* storage('listTags', () => sql.listTags())
    if (folderId !== undefined) {
      if ((yield* storage('readNode', () => sql.readNode(folderId))) === null)
        return yield* Effect.fail(new NotFoundError({ message: 'Folder no longer exists.' }))
      return {
        tags,
        selected: yield* storage('listNodeTagIds', () => sql.listNodeTagIds(folderId)),
      }
    }
    if (templateId === undefined) return { tags, selected: [] as readonly string[] }
    if ((yield* storage('readTemplate', () => sql.readTemplate(templateId))) === null)
      return yield* Effect.fail(new NotFoundError({ message: 'Template no longer exists.' }))
    return {
      tags,
      selected: yield* storage('listTemplateTagIds', () => sql.listTemplateTagIds(templateId)),
    }
  })

/** Commit authoritative metadata before notifying every affected manifest scope. */
export const mutateTag = (mutation: TagMutation, currentSeason: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const readModel = yield* StatusReadModelService
    const scopes = yield* storage('listTagScopes', () => sql.listTagScopes())
    const changed = yield* fromPort('mutateTag', () => sql.mutateTag(mutation, millis(Date.now())))
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
