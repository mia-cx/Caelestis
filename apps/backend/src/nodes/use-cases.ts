import { millis, nodeSlug, type TemplateSurface, uuidV7 } from '@caelestis/shared'
import { Effect } from 'effect'
import type { NodeDeletion, NodeRecord } from '../ports/index.js'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import {
  type ConflictError,
  fromPort,
  type GoneError,
  NotFoundError,
  type StorageError,
  storage,
  ValidationError,
} from '../runtime/errors.js'
import { bestEffort } from '../status-read-model/port.js'

type NodeError = ValidationError | NotFoundError | ConflictError | GoneError | StorageError

export const publicNode = ({
  season: _season,
  surface: _surface,
  description,
  ...node
}: NodeRecord) => (description === null ? node : { ...node, description })

export const createNode = (input: {
  readonly season: number
  readonly surface: TemplateSurface
  readonly parentId: string | null
  readonly name: string
  readonly description?: string
}): Effect.Effect<
  ReturnType<typeof publicNode>,
  NodeError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const segment = nodeSlug(input.name)
    let parentPath = ''
    if (input.parentId !== null) {
      const parent = yield* storage('readNode', () => sql.readNode(input.parentId as string))
      if (parent === null) {
        return yield* Effect.fail(new ValidationError({ message: 'parent node does not exist' }))
      }
      if (parent.season !== input.season) {
        return yield* Effect.fail(
          new ValidationError({ message: 'parent node belongs to a different season' }),
        )
      }
      if (
        parent.surface.kind !== input.surface.kind ||
        parent.surface.allianceId !== input.surface.allianceId
      ) {
        return yield* Effect.fail(
          new ValidationError({ message: 'parent node belongs to a different surface' }),
        )
      }
      parentPath = parent.path
    }

    const node: NodeRecord = {
      id: uuidV7(),
      surface: input.surface,
      season: input.season,
      parentId: input.parentId,
      path: `${parentPath}/${segment}`,
      name: input.name,
      description: input.description ?? null,
      createdAt: millis(Date.now()),
    }
    // A taken path on create has always answered 400, unlike a rename into one (409).
    const inserted = yield* fromPort('insertNode', () => sql.insertNode(node), {
      conflict: 'invalid',
    })
    // A folder alone covers no tiles and owns no alarms.
    yield* Effect.promise(() =>
      bestEffort(() => statusReadModel.notifyManifestChange(input.season, input.surface, false)),
    )
    return publicNode(inserted)
  })

export const listNodes = (
  season: number,
  surface: TemplateSurface,
): Effect.Effect<readonly ReturnType<typeof publicNode>[], StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const nodes = yield* storage('listNodes', () => sql.listNodes(season, surface))
    return nodes.map(publicNode)
  })

export const patchNode = (input: {
  readonly nodeId: string
  readonly name?: string
  readonly parentId?: string | null
}): Effect.Effect<
  ReturnType<typeof publicNode>,
  NodeError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const node = yield* storage('readNode', () => sql.readNode(input.nodeId))
    if (node === null) {
      return yield* Effect.fail(new NotFoundError({ message: 'not found' }))
    }
    const segment = input.name === undefined ? nodeSlug(node.name) : nodeSlug(input.name)
    const nextParentId = input.parentId === undefined ? node.parentId : input.parentId
    let parentPath = node.path.slice(0, node.path.lastIndexOf('/'))
    if (input.parentId !== undefined) {
      if (nextParentId === null) parentPath = ''
      else {
        const parent = yield* storage('readNode', () => sql.readNode(nextParentId))
        if (parent === null) {
          return yield* Effect.fail(new ValidationError({ message: 'parent node does not exist' }))
        }
        parentPath = parent.path
      }
    }
    const path = `${parentPath}/${segment}`
    const changed = yield* fromPort('patchNode', async () => {
      if (input.parentId !== undefined) {
        return sql.moveNode(input.nodeId, nextParentId, path, {
          ...(input.name === undefined ? {} : { name: input.name }),
        })
      }
      if (input.name !== undefined) {
        return (await sql.renameNode(input.nodeId, input.name, segment)) !== null
      }
      return true
    })
    if (!changed) {
      return yield* Effect.fail(new NotFoundError({ message: 'not found' }))
    }
    const updated = yield* storage('readNode', () => sql.readNode(input.nodeId))
    if (updated === null) {
      return yield* Effect.fail(new NotFoundError({ message: 'not found' }))
    }
    yield* Effect.promise(() =>
      // Renaming or moving a folder leaves its templates' tiles and alarms alone.
      bestEffort(() =>
        statusReadModel.notifyManifestChange(updated.season, updated.surface, false),
      ),
    )
    return publicNode(updated)
  })

export const countNodeSubtree = (
  nodeId: string,
): Effect.Effect<
  { readonly nodes: number; readonly templates: number },
  NodeError,
  SqlStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* fromPort('countNodeSubtree', () => sql.countNodeSubtree(nodeId))
  })

export const deleteNodeCascade = (
  nodeId: string,
  expected: NodeDeletion,
): Effect.Effect<NodeDeletion, NodeError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const node = yield* storage('readNode', () => sql.readNode(nodeId))
    if (node === null) {
      return yield* Effect.fail(new NotFoundError({ message: 'not found' }))
    }
    const deleted = yield* fromPort('deleteNodeCascade', () =>
      sql.deleteNodeCascade(nodeId, expected),
    )
    if (deleted.templates > 0) {
      yield* Effect.promise(() =>
        bestEffort(() => statusReadModel.applyCommittedChange(node.season)),
      )
    }
    yield* Effect.promise(() =>
      bestEffort(() => statusReadModel.notifyManifestChange(node.season, node.surface)),
    )
    return deleted
  })

export const deleteEmptyNode = (
  nodeId: string,
): Effect.Effect<void, NodeError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const node = yield* storage('readNode', () => sql.readNode(nodeId))
    if (node === null) {
      return yield* Effect.fail(new NotFoundError({ message: 'not found' }))
    }
    yield* fromPort('deleteNode', () => sql.deleteNode(nodeId))
    // Only an empty folder reaches here.
    yield* Effect.promise(() =>
      bestEffort(() => statusReadModel.notifyManifestChange(node.season, node.surface, false)),
    )
  })
