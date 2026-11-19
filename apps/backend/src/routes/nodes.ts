import {
  isUuidV7,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  nodeSlug,
  parseWholeNumber,
} from '@caelestis/shared'
import { Hono } from 'hono'
import {
  countNodeSubtree,
  createNode,
  deleteEmptyNode,
  deleteNodeCascade,
  listNodes,
  patchNode,
} from '../nodes/use-cases.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { parseSurface } from './params.js'

/** Wplace's first canvas is season 0; later seasons count up from there. */
const parseSeason = (value: unknown): number | null =>
  typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0
      ? value
      : null
    : parseWholeNumber(value)

const slug = nodeSlug

export const createNodeRoutes = (runtime: BackendRuntime) => {
  const routes = new Hono()

  routes.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { season, surfaceKind, allianceId, parentId, name, description } = body as {
      season?: unknown
      surfaceKind?: unknown
      allianceId?: unknown
      parentId?: unknown
      name?: unknown
      description?: unknown
    }
    const parsedSeason = parseSeason(season)
    if (parsedSeason === null) {
      return c.json({ error: 'season must be a non-negative integer' }, 400)
    }
    const surface = parseSurface(surfaceKind, allianceId)
    if (surface === null) {
      return c.json(
        { error: 'surfaceKind must be world or an alliance surface with a positive allianceId' },
        400,
      )
    }
    if (parentId !== null && !isUuidV7(parentId)) {
      return c.json({ error: 'parentId must be null or a canonical lowercase UUIDv7' }, 400)
    }
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    if (
      description !== undefined &&
      (typeof description !== 'string' ||
        description.length === 0 ||
        description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      return c.json({ error: 'description must be 1..4096 characters when provided' }, 400)
    }

    const segment = slug(name)
    if (segment.length === 0) return c.json({ error: 'name must contain a letter or number' }, 400)
    return runBackendHttp(
      c,
      runtime,
      createNode({
        season: parsedSeason,
        surface,
        parentId,
        name,
        ...(description === undefined ? {} : { description: description as string }),
      }),
      (node) => c.json(node, 201),
    )
  })

  routes.get('/', async (c) => {
    const season = parseSeason(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const surface = parseSurface(c.req.query('surface'), c.req.query('allianceId'))
    if (surface === null) {
      return c.json(
        { error: 'surface must be world or an alliance surface with a positive allianceId' },
        400,
      )
    }
    return runBackendHttp(c, runtime, listNodes(season, surface), (nodes) => c.json(nodes))
  })

  routes.patch('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!isUuidV7(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { name, parentId } = body as { name?: unknown; parentId?: unknown }
    if (
      name !== undefined &&
      (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH)
    ) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    if (parentId !== undefined && parentId !== null && !isUuidV7(parentId)) {
      return c.json({ error: 'parentId must be null or a canonical lowercase UUIDv7' }, 400)
    }
    if (name === undefined && parentId === undefined) {
      return c.json({ error: 'patch must set at least one of name, parentId' }, 400)
    }
    const requestedSegment = name === undefined ? undefined : slug(name)
    if (requestedSegment !== undefined && requestedSegment.length === 0) {
      return c.json({ error: 'name must contain a letter or number' }, 400)
    }

    return runBackendHttp(
      c,
      runtime,
      patchNode({
        nodeId,
        ...(name === undefined ? {} : { name: name as string }),
        ...(parentId === undefined ? {} : { parentId: parentId as string | null }),
      }),
      (node) => c.json(node),
    )
  })

  routes.get('/:id/subtree', async (c) => {
    const nodeId = c.req.param('id')
    if (!isUuidV7(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    return runBackendHttp(c, runtime, countNodeSubtree(nodeId), (counts) => c.json(counts))
  })

  routes.delete('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!isUuidV7(nodeId)) {
      return c.json({ error: 'id must be a canonical lowercase UUIDv7' }, 400)
    }
    if (c.req.query('cascade') === 'true') {
      const expectedNodes = parseSeason(c.req.query('expectedNodes'))
      const expectedTemplates = parseSeason(c.req.query('expectedTemplates'))
      if (expectedNodes === null || expectedNodes < 1 || expectedTemplates === null) {
        return c.json({ error: 'cascade requires non-negative expected counts' }, 400)
      }
      return runBackendHttp(
        c,
        runtime,
        deleteNodeCascade(nodeId, {
          nodes: expectedNodes,
          templates: expectedTemplates,
        }),
        (deleted) =>
          // R2 and D1 share no transaction, so deleting blobs after the D1 commit could race a new
          // reference to the same content. Chunks stay until a collector can prove a hash
          // unreferenced.
          c.json({ nodes: deleted.nodes, templates: deleted.templates, chunks: 0 }),
      )
    }

    return runBackendHttp(c, runtime, deleteEmptyNode(nodeId), () => c.body(null, 204))
  })

  return routes
}
