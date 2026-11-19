import { type Millis, sameTemplateSurface, type TemplateSurface } from '@caelestis/shared'
import type { DrawingScope } from '../db/scope.js'
import { PortError } from '../runtime/errors.js'

export interface NodeRecord {
  readonly id: string
  readonly surface: TemplateSurface
  readonly season: number
  readonly parentId: string | null
  readonly path: string
  readonly name: string
  readonly description: string | null
  readonly createdAt: Millis
}

/** A node to create. Its path is its parent's path at the moment of the write, plus `slug`. */
export interface NewNode extends Omit<NodeRecord, 'path'> {
  readonly slug: string
}

/** A rename that travels with a move: the new name and the path segment derived from it. */
export interface NodeRename {
  readonly name: string
  readonly slug: string
}

/** Everything a cascading delete removed, so a caller can say what it did. */
export interface NodeDeletion {
  readonly nodes: number
  readonly templates: number
}

export class NodePathConflictError extends PortError {
  override readonly name = 'NodePathConflictError'
  readonly kind = 'conflict'
}

/**
 * A path past `MAX_NODE_PATH_LENGTH`. The store checks rather than the route because a rename is
 * what can exceed it without anyone naming an over-long string: renaming an ancestor lengthens
 * every path beneath it, so the request that breaks the bound is one whose own path is comfortably
 * inside it.
 */
export class NodePathTooLongError extends PortError {
  override readonly name = 'NodePathTooLongError'
  readonly kind = 'invalid'
}

export class InvalidNodeParentError extends PortError {
  override readonly name = 'InvalidNodeParentError'
  readonly kind = 'invalid'
}

export class NodeNotFoundError extends PortError {
  override readonly name = 'NodeNotFoundError'
  readonly kind = 'not-found'
}

/** Refuse `node` as the parent of `child` unless it lives in the child's own scope. */
export const assertSameScope = (
  node: DrawingScope,
  child: DrawingScope,
  role: 'parent node' | 'destination node',
): void => {
  if (node.season !== child.season)
    throw new InvalidNodeParentError(`${role} belongs to a different season`)
  if (!sameTemplateSurface(node.surface, child.surface))
    throw new InvalidNodeParentError(`${role} belongs to a different surface`)
}

/** The subtree no longer matches the snapshot an administrator confirmed deleting. */
export class NodeSubtreeChangedError extends PortError {
  override readonly name = 'NodeSubtreeChangedError'
  readonly kind = 'conflict'
}

export class NodeNotEmptyError extends PortError {
  override readonly name = 'NodeNotEmptyError'
  readonly kind = 'conflict'
}

/**
 * The folder tree. A node's `path` is materialized: its parent's path plus its own slug. The store
 * composes every path from live rows inside the write, so a caller never supplies a prefix that a
 * concurrent rename could have made stale, and validates parents atomically with the write.
 */
export interface NodeStore {
  /**
   * Insert a node under its parent, and answer with the row as stored.
   *
   * Throws `NodePathConflictError` when the composed path is taken, `NodePathTooLongError` when it
   * exceeds `MAX_NODE_PATH_LENGTH`, and `InvalidNodeParentError` when the parent is missing or on
   * another season or surface.
   */
  insertNode(node: NewNode): Promise<NodeRecord>

  readNode(nodeId: string): Promise<NodeRecord | null>

  listNodes(season: number, surface?: TemplateSurface): Promise<readonly NodeRecord[]>

  /**
   * Rename a node and rewrite the paths of everything beneath it, atomically.
   *
   * Returns the renamed node, or null when the id does not exist. Throws `NodePathConflictError`
   * when the destination collides with a sibling, and `NodePathTooLongError` when the rename would
   * push the node or any descendant past `MAX_NODE_PATH_LENGTH`.
   */
  renameNode(nodeId: string, name: string, slug: string): Promise<NodeRecord | null>

  /**
   * Re-parent a node, renaming it too when `rename` is given, and rewrite the paths beneath it.
   *
   * Returns false when the node does not exist. Throws `InvalidNodeParentError` when the destination
   * does not exist, belongs to another season or surface, or is the node itself or one of its own
   * descendants; `NodePathConflictError` when the new path collides with a sibling.
   */
  moveNode(nodeId: string, parentId: string | null, rename?: NodeRename): Promise<boolean>

  /** Throws `NodeNotEmptyError` while children or templates still hang from the node. */
  deleteNode(nodeId: string): Promise<void>

  /** Throws `NodeSubtreeChangedError` unless the subtree still holds exactly `expected`. */
  deleteNodeCascade(nodeId: string, expected: NodeDeletion): Promise<void>

  /** How much a cascading delete would remove, without removing it. */
  countNodeSubtree(nodeId: string): Promise<NodeDeletion>
}
