import {
  sameTemplateSurface,
  type TemplateSurface,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import { violates } from '../adapters/constraint-violation.js'
import { changedRows, type relationalDatabase } from '../adapters/relational-database.js'
import { RelationalStore } from '../adapters/relational-store.js'
import { contributions, nodes, templates, templateVersions, versionTiles } from '../db/schema.js'
import {
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
 * SQLite LIKE did. SQLite supplies both lengths so the comparison stays in characters throughout.
 */
const pathStartsWith = (prefix: SQL | string): SQL =>
  sql`lower(substr(${nodes.path}, 1, length(${prefix}))) = lower(${prefix})`

const nodeSurfaceWhere = (surface: TemplateSurface): SQL =>
  and(
    eq(nodes.surfaceKind, surface.kind),
    surface.allianceId === null
      ? isNull(nodes.allianceId)
      : eq(nodes.allianceId, surface.allianceId),
  ) as SQL

const nodeScopeWhere = (season: number, surface: TemplateSurface): SQL =>
  and(eq(nodes.season, season), nodeSurfaceWhere(surface)) as SQL

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
 * Retries of a parent-only move that lost its guard to a concurrent rename. D1 has no interactive
 * transactions, so a move is an optimistic batch that re-reads the live row on conflict.
 */
const MOVE_ATTEMPTS = 3

const toNode = (row: typeof nodes.$inferSelect): NodeRecord => {
  const surface = templateSurface(row.surfaceKind, row.allianceId)
  if (surface === null) throw new Error(`node ${row.id} has an invalid surface`)
  return {
    id: row.id,
    surface,
    season: row.season,
    parentId: row.parentId,
    path: row.path,
    name: row.name,
    description: row.description,
    createdAt: row.createdAtMs,
  }
}

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
      // The named index, not the bare string: `nodes` has two unique constraints, and reporting a
      // primary-key collision as a path conflict sends the caller after the wrong recovery, so an id
      // collision stays untyped.
      if (violates(error, 'unique', NODE_PATH_UNIQUE)) {
        throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
      }
      // The parent check above is a separate read, so a concurrent delete can remove the parent
      // between the two and the foreign key rejects this insert. Same outcome as the check finding
      // it missing, so it gets the same error rather than escaping as a 500.
      if (violates(error, 'foreign-key')) {
        throw new InvalidNodeParentError('parent node does not exist')
      }
      // The route bounds the path it derived, but the prefix written here comes from the parent row,
      // which a rename may have lengthened since. The CHECK is the authority; losing to it answers
      // the same 400 as failing the route's own check rather than a 500.
      if (violates(error, 'check', NODE_PATH_CHECK)) {
        throw new NodePathTooLongError(`node path is longer than ${MAX_NODE_PATH_LENGTH}`)
      }
      throw error
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
    if (parent.season !== child.season) {
      throw new InvalidNodeParentError('parent node belongs to a different season')
    }
    if (!sameTemplateSurface(parent.surface, child.surface)) {
      throw new InvalidNodeParentError('parent node belongs to a different surface')
    }
    return parent
  }

  async listNodes(
    season: number,
    surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
  ): Promise<readonly NodeRecord[]> {
    const rows = await this.database
      .select()
      .from(nodes)
      .where(nodeScopeWhere(season, surface))
      .orderBy(asc(nodes.id))
    return rows.map(toNode)
  }

  async renameNode(nodeId: string, name: string, slug: string): Promise<NodeRecord | null> {
    const node = await this.readNode(nodeId)
    if (node === null) return null

    const oldPrefix = `${node.path}/`
    const descendants = and(nodeScopeWhere(node.season, node.surface), pathStartsWith(oldPrefix))

    // Every descendant keeps its suffix, so its new length is its old one shifted by the change in
    // the prefix — one aggregate, no rows. `slug` keeps paths inside the BMP, so SQLite's character
    // count and the UTF-16 count the wire uses are the same number; this used to read every
    // descendant path because they were not, which a season-sized subtree turns into a result set D1
    // refuses.
    //
    // That equality is an assumption, and the route is what holds it up: every stored path is one
    // `slug` derived. A path with an astral character would make this under-count, the CHECK agree
    // with it, and the resulting manifest stop decoding — so if a second writer ever appears, or rows
    // arrive from anywhere but this route, this aggregate has to go back to measuring the rows.
    // Nothing has been deployed from this schema, so there are no such rows to migrate today.
    const path = `${node.path.slice(0, node.path.lastIndexOf('/'))}/${slug}`
    const shift = path.length - node.path.length
    const [deepest] = await this.database
      .select({ length: sql<number>`coalesce(max(length(${nodes.path})), 0)` })
      .from(nodes)
      .where(descendants)
    const longest = Math.max(path.length, (deepest?.length ?? 0) + shift)
    if (longest > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(
        `rename would derive a path longer than ${MAX_NODE_PATH_LENGTH}`,
      )
    }

    // The old path is read inside the batch rather than carried in from the read above, so the two
    // statements agree about what they are moving. Carried in, two concurrent renames of the same
    // node both saw `/x`: the first moved the node to `/a` and its children with it, the second then
    // moved the node to `/b` and rewrote `/x/%`, which by then matched nothing — leaving the node at
    // `/b` and its children at `/a/c`. The batch was atomic the whole time; the value it was built
    // from was not.
    //
    // The destination is composed from the node's live parent for the same reason. A concurrent move
    // can change `parentId` after the guard read; carrying the old id into this batch leaves the new
    // parent pointer paired with a path under the old parent.
    const liveParentId = sql`(select parent_id from nodes where id = ${nodeId})`
    const parentPath = sql`coalesce((select path from nodes where id = ${liveParentId}), '')`
    const destination = sql`${parentPath} || '/' || ${slug}`
    const oldPath = sql`(select path from nodes where id = ${nodeId})`

    // One batch: the node and every descendant move together or not at all. A half-applied rename
    // leaves children whose path no longer starts with their parent's, which silently breaks every
    // prefix rollup rather than failing loudly.
    //
    // Descendants first, while the node row still holds the old path they are matched against. The
    // suffix starts at the old path's length rather than the old prefix's, so it keeps the
    // separating slash — cutting past it concatenated `/renamed` with `child` and wrote
    // `/renamedchild`. `length()` is SQLite's, which counts characters like `substr` does, where
    // JavaScript's counts UTF-16 units and sliced every descendant short past an astral character.
    const statements = [
      this.database
        .update(nodes)
        .set({ path: sql`${destination} || substr(${nodes.path}, length(${oldPath}) + 1)` })
        .where(
          and(nodeScopeWhere(node.season, node.surface), pathStartsWith(sql`${oldPath} || '/'`)),
        ),
      this.database.update(nodes).set({ name, path: destination }).where(eq(nodes.id, nodeId)),
    ] as const
    try {
      await this.database.batch([statements[0], statements[1]])
    } catch (error) {
      if (violates(error, 'unique', NODE_PATH_UNIQUE)) {
        throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
      }
      // The guard above reads a snapshot, so a child inserted between it and this batch can be
      // lengthened past the bound by a rename that was measured without it. The CHECK is the
      // authority; losing to it answers the same 400 as failing the guard rather than a 500.
      if (violates(error, 'check', NODE_PATH_CHECK)) {
        throw new NodePathTooLongError(
          `rename would derive a path longer than ${MAX_NODE_PATH_LENGTH}`,
        )
      }
      throw error
    }
    // Re-read rather than assemble: the path the database composed is the one that is true.
    return this.readNode(nodeId)
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
    const path = `${parent?.path ?? ''}/${segment}`
    const oldPrefix = `${node.path}/`
    const descendants = and(nodeScopeWhere(node.season, node.surface), pathStartsWith(oldPrefix))
    const shift = path.length - node.path.length
    const [deepest] = await this.database
      .select({ length: sql<number>`coalesce(max(length(${nodes.path})), 0)` })
      .from(nodes)
      .where(descendants)
    if (Math.max(path.length, (deepest?.length ?? 0) + shift) > MAX_NODE_PATH_LENGTH) {
      throw new NodePathTooLongError(`move would derive a path longer than ${MAX_NODE_PATH_LENGTH}`)
    }

    const destination =
      parentId === null
        ? sql`'/' || ${segment}`
        : sql`(select path from nodes where id = ${parentId}) || '/' || ${segment}`
    const oldPath = sql`(select path from nodes where id = ${nodeId})`
    // A rename between the guard read and this batch changes both name and path. Do not combine its
    // live name with our stale segment: let the batch make no change and retry from the new row.
    const nodeIsStillCurrent = rename === undefined ? sql`${oldPath} = ${node.path}` : sql`1 = 1`
    // Re-evaluate the parent against the node's live path inside each batch statement. Two opposite
    // moves may both pass the reads above, but only the first can still satisfy this predicate once
    // its write makes the other destination a descendant.
    const parentIsStillValid =
      parentId === null
        ? sql`1 = 1`
        : sql`(
            select path from nodes where id = ${parentId} and season = ${node.season}
          ) is not null and lower(substr(
            (select path from nodes where id = ${parentId} and season = ${node.season}),
            1,
            length(${oldPath}) + 1
          )) <> lower(${oldPath} || '/') and lower(
            (select path from nodes where id = ${parentId} and season = ${node.season})
          ) <> lower(${oldPath})`
    const statements = [
      this.database
        .update(nodes)
        .set({ path: sql`${destination} || substr(${nodes.path}, length(${oldPath}) + 1)` })
        .where(
          and(
            nodeScopeWhere(node.season, node.surface),
            pathStartsWith(sql`${oldPath} || '/'`),
            parentIsStillValid,
            nodeIsStillCurrent,
          ),
        ),
      this.database
        .update(nodes)
        .set({
          parentId,
          path: destination,
          ...(rename === undefined ? {} : { name: rename.name }),
        })
        .where(and(eq(nodes.id, nodeId), parentIsStillValid, nodeIsStillCurrent)),
    ] as const
    try {
      await this.database.batch([statements[0], statements[1]])
    } catch (error) {
      if (violates(error, 'unique', NODE_PATH_UNIQUE)) {
        throw new NodePathConflictError(`node path is already taken in season ${node.season}`)
      }
      if (violates(error, 'check', NODE_PATH_CHECK)) {
        throw new NodePathTooLongError(
          `move would derive a path longer than ${MAX_NODE_PATH_LENGTH}`,
        )
      }
      throw error
    }
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
    const subtree = or(
      eq(nodes.id, nodeId),
      and(nodeScopeWhere(node.season, node.surface), pathStartsWith(`${node.path}/`)),
    )
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
    const liveSubtree = or(
      eq(nodes.id, nodeId),
      and(nodeScopeWhere(node.season, node.surface), pathStartsWith(sql`${rootPath} || '/'`)),
    )
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
