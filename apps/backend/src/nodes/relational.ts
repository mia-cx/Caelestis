import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { and, asc, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import { violates } from '../adapters/constraint-violation.js'
import { changedRows, type relationalDatabase } from '../adapters/relational-database.js'
import { RelationalStore } from '../adapters/relational-store.js'
import { contributions, nodes, templates, templateVersions, versionTiles } from '../db/schema.js'
import { scopeWhere, surfaceOf } from '../db/scope.js'
import {
  assertSameScope,
  InvalidNodeParentError,
  MAX_NODE_PATH_LENGTH,
  type NewNode,
  type NodeDeletion,
  NodeNotEmptyError,
  NodeNotFoundError,
  NodePathConflictError,
  NodePathTooLongError,
  type NodeRecord,
  type NodeRename,
  type NodeStore,
  NodeSubtreeChangedError,
} from './store.js'

/**
 * Case-insensitive path-prefix matching without a LIKE pattern.
 *
 * D1 caps a LIKE or GLOB pattern at 50 bytes, while a node path may be 256 characters. `substr`
 * compares the same prefix without constructing a pattern, and `lower` folds ASCII exactly as
 * SQLite LIKE does. SQLite supplies both lengths so the comparison stays in characters throughout.
 */
const pathStartsWith = (prefix: SQL | string): SQL =>
  sql`lower(substr(${nodes.path}, 1, length(${prefix}))) = lower(${prefix})`

/** Every node beneath `node`, matched by path within its scope. */
const descendantsOf = (node: NodeRecord, path: SQL | string): SQL =>
  and(scopeWhere(nodes, node.season, node.surface), pathStartsWith(path)) as SQL

/**
 * The path index per schema: SQLite and PostgreSQL split world and alliance paths, MariaDB keys
 * both on one generated column. Only this index makes a path conflict; an id collision on the
 * primary key stays untyped, so the caller is not sent after the wrong recovery.
 */
const NODE_PATH_UNIQUE = [
  'nodes_world_path_idx',
  'nodes_alliance_surface_path_idx',
  'nodes_surface_path_idx',
]
const NODE_PATH_CHECK = ['nodes_path_check']

/**
 * A path write that lost to the path index or the length CHECK, as the store's typed error. The
 * store's own guards are reads, so a concurrent write can still make the database the authority;
 * losing to it answers what failing the guard would have.
 */
const pathViolation = (error: unknown, season: number, tooLong: string): unknown => {
  if (violates(error, 'unique', NODE_PATH_UNIQUE))
    return new NodePathConflictError(`node path is already taken in season ${season}`)
  if (violates(error, 'check', NODE_PATH_CHECK)) return new NodePathTooLongError(tooLong)
  return error
}

/**
 * Retries of a parent-only move that lost its guard to a concurrent rename. D1 has no interactive
 * transactions, so a move is an optimistic batch that re-reads the live row on conflict.
 */
const MOVE_ATTEMPTS = 3

const toNode = (row: typeof nodes.$inferSelect): NodeRecord => ({
  id: row.id,
  surface: surfaceOf(row, `node ${row.id}`),
  season: row.season,
  parentId: row.parentId,
  path: row.path,
  name: row.name,
  description: row.description,
  createdAt: row.createdAtMs,
})

/** One node, for this store and for stores that validate a destination node. */
export const selectNode = async (
  database: ReturnType<typeof relationalDatabase>,
  nodeId: string,
): Promise<NodeRecord | null> => {
  const rows = await database.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1)
  const row = rows[0]
  return row === undefined ? null : toNode(row)
}

export class RelationalNodeStore extends RelationalStore implements NodeStore {
  async insertNode(node: NewNode): Promise<NodeRecord> {
    let parentPath = ''
    if (node.parentId !== null) {
      parentPath = (await this.#parentFor(node.parentId, node)).path
    }
    // Bounded here for a typed error; the CHECK stays the backstop for the window between this read
    // and the write, in which a rename can lengthen the prefix underneath us.
    if (`${parentPath}/${node.slug}`.length > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(`node path is longer than ${MAX_NODE_PATH_LENGTH}`)
    }
    // The prefix comes from the parent row inside the write, not from the read above: a rename
    // committing in between would otherwise attach the child under a prefix its parent no longer has.
    const path =
      node.parentId === null
        ? sql`${`/${node.slug}`}`
        : sql`coalesce((select path from nodes where id = ${node.parentId}), '') || '/' || ${node.slug}`
    try {
      await this.database.insert(nodes).values({
        id: node.id,
        season: node.season,
        surfaceKind: node.surface.kind,
        allianceId: node.surface.allianceId,
        parentId: node.parentId,
        path,
        name: node.name,
        description: node.description,
        createdAtMs: node.createdAt,
      })
    } catch (error) {
      // A concurrent delete of the parent is the parent check finding it missing.
      if (violates(error, 'foreign-key'))
        throw new InvalidNodeParentError('parent node does not exist')
      throw pathViolation(error, node.season, `node path is longer than ${MAX_NODE_PATH_LENGTH}`)
    }
    // Re-read rather than assemble: the path the database composed is the one that is true.
    const inserted = await this.readNode(node.id)
    if (inserted === null) throw new NodeNotFoundError(`node does not exist: ${node.id}`)
    return inserted
  }

  readNode(nodeId: string): Promise<NodeRecord | null> {
    return selectNode(this.database, nodeId)
  }

  /** The parent row, refused unless it exists on the child's own season and surface. */
  async #parentFor(
    parentId: string,
    child: Pick<NodeRecord, 'season' | 'surface'>,
  ): Promise<NodeRecord> {
    const parent = await this.readNode(parentId)
    if (parent === null) throw new InvalidNodeParentError('parent node does not exist')
    assertSameScope(parent, child, 'parent node')
    return parent
  }

  async listNodes(
    season: number,
    surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
  ): Promise<readonly NodeRecord[]> {
    const rows = await this.database
      .select()
      .from(nodes)
      .where(scopeWhere(nodes, season, surface))
      .orderBy(asc(nodes.id))
    return rows.map(toNode)
  }

  async renameNode(nodeId: string, name: string, slug: string): Promise<NodeRecord | null> {
    const node = await this.readNode(nodeId)
    if (node === null) return null
    // The destination is composed from the node's live parent: a concurrent move can change
    // `parentId` after the read above, and the old id would pair the new parent with a path under
    // the old one.
    const liveParentId = sql`(select parent_id from nodes where id = ${nodeId})`
    const parentPath = sql`coalesce((select path from nodes where id = ${liveParentId}), '')`
    await this.#rewriteSubtree(node, {
      verb: 'rename',
      path: `${node.path.slice(0, node.path.lastIndexOf('/'))}/${slug}`,
      destination: sql`${parentPath} || '/' || ${slug}`,
      changes: { name },
    })
    return this.readNode(nodeId)
  }

  /**
   * Move `node` to `destination` and every descendant with it, in one batch: a half-applied rewrite
   * leaves children whose path no longer starts with their parent's, which silently breaks every
   * prefix rollup.
   *
   * `path` is the destination as the guard read sees it, to bound the result before writing. The
   * batch itself reads the old path live, so two concurrent rewrites of one node agree on what
   * they move. `guard` must hold for either statement to change anything.
   */
  async #rewriteSubtree(
    node: NodeRecord,
    rewrite: {
      readonly verb: 'rename' | 'move'
      readonly path: string
      readonly destination: SQL
      readonly changes: { readonly name?: string; readonly parentId?: string | null }
      readonly guard?: SQL | undefined
    },
  ): Promise<void> {
    const tooLong = `${rewrite.verb} would derive a path longer than ${MAX_NODE_PATH_LENGTH}`
    // Every descendant keeps its suffix, so its new length is its old one shifted by the change in
    // the prefix: one aggregate, no rows, because a season-sized subtree read row by row is a
    // result set D1 refuses. `slug` keeps paths inside the BMP, so SQLite's character count and the
    // UTF-16 count the wire uses are the same number. That holds only while every stored path is
    // one `slug` derived; rows from any other writer would need measuring row by row.
    const [deepest] = await this.database
      .select({ length: sql<number>`coalesce(max(length(${nodes.path})), 0)` })
      .from(nodes)
      .where(descendantsOf(node, `${node.path}/`))
    const shift = rewrite.path.length - node.path.length
    if (Math.max(rewrite.path.length, (deepest?.length ?? 0) + shift) > MAX_NODE_PATH_LENGTH)
      throw new NodePathTooLongError(tooLong)

    const { destination, guard } = rewrite
    const oldPath = sql`(select path from nodes where id = ${node.id})`
    try {
      // Descendants first, while the node row still holds the old path they match. The suffix
      // starts at the old path's length, so it keeps the separating slash. SQLite's `length()`
      // counts characters like `substr` does, where JavaScript counts UTF-16 units.
      await this.database.batch([
        this.database
          .update(nodes)
          .set({ path: sql`${destination} || substr(${nodes.path}, length(${oldPath}) + 1)` })
          .where(and(descendantsOf(node, sql`${oldPath} || '/'`), guard)),
        this.database
          .update(nodes)
          .set({ ...rewrite.changes, path: destination })
          .where(and(eq(nodes.id, node.id), guard)),
      ])
    } catch (error) {
      throw pathViolation(error, node.season, tooLong)
    }
  }

  moveNode(nodeId: string, parentId: string | null, rename?: NodeRename): Promise<boolean> {
    return this.#moveAttempt(nodeId, parentId, rename, 0)
  }

  async #moveAttempt(
    nodeId: string,
    parentId: string | null,
    rename: NodeRename | undefined,
    attempt: number,
  ): Promise<boolean> {
    const node = await this.readNode(nodeId)
    if (node === null) return false

    const parent = parentId === null ? null : await this.#parentFor(parentId, node)
    if (parent !== null && (parent.id === node.id || parent.path.startsWith(`${node.path}/`))) {
      throw new InvalidNodeParentError(
        'parent node cannot be the node itself or one of its descendants',
      )
    }

    // For a parent-only move, the path segment belongs to the live row.
    const segment = rename?.slug ?? node.path.slice(node.path.lastIndexOf('/') + 1)
    const oldPath = sql`(select path from nodes where id = ${nodeId})`
    // A rename between the guard read and this batch changes both name and path. Do not combine its
    // live name with our stale segment: let the batch make no change and retry from the new row.
    const nodeIsStillCurrent = rename === undefined ? sql`${oldPath} = ${node.path}` : undefined
    // Re-evaluate the parent against the node's live path inside each batch statement. Two opposite
    // moves may both pass the reads above, but only the first can still satisfy this predicate once
    // its write makes the other destination a descendant.
    const parentIsStillValid =
      parentId === null
        ? undefined
        : sql`(
            select path from nodes where id = ${parentId} and season = ${node.season}
          ) is not null and lower(substr(
            (select path from nodes where id = ${parentId} and season = ${node.season}),
            1,
            length(${oldPath}) + 1
          )) <> lower(${oldPath} || '/') and lower(
            (select path from nodes where id = ${parentId} and season = ${node.season})
          ) <> lower(${oldPath})`
    await this.#rewriteSubtree(node, {
      verb: 'move',
      path: `${parent?.path ?? ''}/${segment}`,
      destination:
        parentId === null
          ? sql`'/' || ${segment}`
          : sql`(select path from nodes where id = ${parentId}) || '/' || ${segment}`,
      changes: rename === undefined ? { parentId } : { parentId, name: rename.name },
      guard: and(parentIsStillValid, nodeIsStillCurrent),
    })
    const moved = await this.readNode(nodeId)
    if (moved === null) return false
    if (moved.parentId !== parentId) {
      if (rename === undefined && attempt < MOVE_ATTEMPTS) {
        return await this.#moveAttempt(nodeId, parentId, rename, attempt + 1)
      }
      throw new InvalidNodeParentError('parent node became invalid during the move')
    }
    return true
  }

  async deleteNode(nodeId: string): Promise<void> {
    const [children, attachedTemplates] = await Promise.all([
      this.database.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentId, nodeId)).limit(1),
      this.database
        .select({ id: templates.id })
        .from(templates)
        .where(eq(templates.nodeId, nodeId))
        .limit(1),
    ])
    if (children.length > 0 || attachedTemplates.length > 0) {
      throw new NodeNotEmptyError('node has children or templates')
    }
    try {
      await this.database.delete(nodes).where(eq(nodes.id, nodeId))
    } catch (error) {
      // The guards are reads, so a child or template can be attached after they come back empty and
      // before this runs. The foreign key is the authority either way; translate it rather than
      // letting the race be the one path that answers 500 instead of 409.
      if (violates(error, 'foreign-key')) {
        throw new NodeNotEmptyError('node has children or templates')
      }
      throw error
    }
  }

  async countNodeSubtree(nodeId: string): Promise<{ nodes: number; templates: number }> {
    const node = await this.readNode(nodeId)
    if (node === null) throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
    const subtree = or(eq(nodes.id, nodeId), descendantsOf(node, `${node.path}/`))
    const [nodeRows, templateRows] = await Promise.all([
      this.database.select({ count: sql<number>`count(*)` }).from(nodes).where(subtree),
      this.database
        .select({ count: sql<number>`count(*)` })
        .from(templates)
        .innerJoin(nodes, eq(nodes.id, templates.nodeId))
        .where(subtree),
    ])
    return { nodes: nodeRows[0]?.count ?? 0, templates: templateRows[0]?.count ?? 0 }
  }

  async deleteNodeCascade(nodeId: string, expected: NodeDeletion): Promise<NodeDeletion> {
    const node = await this.readNode(nodeId)
    if (node === null) throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
    // Every statement reads the root path inside the same transaction. Carrying `node.path` from the
    // read above lets a concurrent rename/move make the batch select the root by id but miss its
    // descendants, and the final delete then loses to their foreign keys.
    const rootPath = sql`(select path from nodes where id = ${nodeId})`
    const liveSubtree = or(eq(nodes.id, nodeId), descendantsOf(node, sql`${rootPath} || '/'`))
    const liveNodeCount = sql`(select count(*) from ${nodes} where ${liveSubtree})`
    const liveTemplateCount = sql`(
      select count(*) from ${templates}
      inner join ${nodes} on ${nodes.id} = ${templates.nodeId}
      where ${liveSubtree}
    )`
    const token = crypto.randomUUID()
    const claimed = this.database
      .update(nodes)
      .set({ deleteToken: token })
      .where(
        and(
          eq(nodes.id, nodeId),
          sql`${liveNodeCount} = ${expected.nodes}`,
          sql`${liveTemplateCount} = ${expected.templates}`,
        ),
      )
    const hasClaim = sql`(select delete_token from nodes where id = ${nodeId}) = ${token}`
    const subtree = and(liveSubtree, hasClaim)

    const subtreeNodeIds = this.database.select({ id: nodes.id }).from(nodes).where(subtree)
    const subtreeTemplateIds = this.database
      .select({ id: templates.id })
      .from(templates)
      .where(inArray(templates.nodeId, subtreeNodeIds))
    const subtreeVersionIds = this.database
      .select({ id: templateVersions.id })
      .from(templateVersions)
      .where(inArray(templateVersions.templateId, subtreeTemplateIds))

    // Order matters and the batch is what makes it safe. `templates.current_version_id` points at a
    // version and every version points back at the template, so the pointer has to be dropped before
    // the rows it refers to. Tiles go before the versions they belong to, and nodes remain until the
    // templates no longer refer to them. One batch means no caller can observe a half-deleted tree.
    const statements = [
      claimed,
      this.database
        .update(templates)
        .set({ currentVersionId: null })
        .where(inArray(templates.id, subtreeTemplateIds)),
      this.database.delete(versionTiles).where(inArray(versionTiles.versionId, subtreeVersionIds)),
      this.database.delete(templateVersions).where(inArray(templateVersions.id, subtreeVersionIds)),
      // Contributions enforce their template reference too, so they must leave before templates.
      this.database
        .delete(contributions)
        .where(inArray(contributions.templateId, subtreeTemplateIds)),
      this.database.delete(templates).where(inArray(templates.id, subtreeTemplateIds)),
      // InnoDB checks `parent_id` row by row while one DELETE runs, so it can refuse a parent whose
      // child is still waiting in the same statement. Detaching the subtree first leaves nothing to
      // check; the subtree is matched by path, not by parent.
      this.database.update(nodes).set({ parentId: null }).where(subtree),
      this.database.delete(nodes).where(subtree),
    ] as const
    const results = await this.database.batch(statements)
    if (changedRows(results[0]) === 0) {
      if ((await this.readNode(nodeId)) === null) {
        throw new NodeNotFoundError(`node does not exist: ${nodeId}`)
      }
      throw new NodeSubtreeChangedError('node subtree changed after it was counted')
    }

    return expected
  }
}
