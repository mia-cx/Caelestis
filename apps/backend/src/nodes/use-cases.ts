import { millis, type ProgressWindow, type TemplateSurface, uuidV7 } from '@caelestis/shared'
import { Effect } from 'effect'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import {
  type ConflictError,
  fromPort,
  type GoneError,
  NotFoundError,
  type StorageError,
  storage,
  type ValidationError,
} from '../runtime/errors.js'
import { bestEffort } from '../status-read-model/port.js'
import type { NewNode, NodeDeletion, NodeRecord, NodeRename } from './store.js'

type NodeError = ValidationError | NotFoundError | ConflictError | GoneError | StorageError

export const publicNode = ({
  season: _season,
  surface: _surface,
  description,
  ...node
}: NodeRecord) => (description === null ? node : { ...node, description })

/** Create a node; `slug` is the path segment the caller derived from `name` with `nodeSlug`. */
export const createNode = (input: {
  readonly season: number
  readonly surface: TemplateSurface
  readonly parentId: string | null
  readonly name: string
  readonly slug: string
  readonly description?: string
}): Effect.Effect<
  ReturnType<typeof publicNode>,
  NodeError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const node: NewNode = {
      id: uuidV7(),
      surface: input.surface,
      season: input.season,
      parentId: input.parentId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      createdAt: millis(Date.now()),
    }
    // A taken path on create is bad input (400); a rename into one is a conflict (409).
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
  readonly rename?: NodeRename
  readonly parentId?: string | null
}): Effect.Effect<
  ReturnType<typeof publicNode>,
  NodeError,
  SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const { rename, parentId } = input
    const changed = yield* fromPort('patchNode', async () => {
      if (parentId !== undefined) return sql.moveNode(input.nodeId, parentId, rename)
      if (rename !== undefined) {
        return (await sql.renameNode(input.nodeId, rename.name, rename.slug)) !== null
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

export const setNodeProgressWindow = (nodeId: string, progressWindow: ProgressWindow) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const node = yield* storage('updateNodeProgressWindow', () =>
      sql.updateNodeProgressWindow(nodeId, progressWindow),
    )
    if (node === null) return yield* Effect.fail(new NotFoundError({ message: 'not found' }))
    yield* Effect.promise(() =>
      bestEffort(() => statusReadModel.notifyManifestChange(node.season, node.surface, false)),
    )
    return publicNode(node)
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
    yield* fromPort('deleteNodeCascade', () => sql.deleteNodeCascade(nodeId, expected))
    if (expected.templates > 0) {
      yield* Effect.promise(() =>
        bestEffort(() => statusReadModel.applyCommittedChange(node.season)),
      )
    }
    yield* Effect.promise(() =>
      bestEffort(() => statusReadModel.notifyManifestChange(node.season, node.surface)),
    )
    return expected
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
