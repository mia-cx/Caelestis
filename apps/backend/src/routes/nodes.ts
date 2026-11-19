import { isUuidV7, MAX_DESCRIPTION_LENGTH, nodeSlug, parseWholeNumber } from '@caelestis/shared'
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
import {
  emptyPatch,
  INVALID_NAME,
  invalidSurface,
  isName,
  jsonObject,
  parseSurface,
} from './params.js'

/** A non-negative integer, from a JSON number or query text. */
const wholeNumber = (value: unknown): number | null =>
  typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0
      ? value
      : null
    : parseWholeNumber(value)

const INVALID_ID = 'id must be a canonical lowercase UUIDv7'
const INVALID_PARENT = 'parentId must be null or a canonical lowercase UUIDv7'
const UNSLUGGABLE_NAME = 'name must contain a letter or number'

export const createNodeRoutes = (runtime: BackendRuntime) => {
  const routes = new Hono()

  routes.post('/', async (c) => {
    const body = await jsonObject(c)
    if (body === null) return c.json({ error: 'invalid body' }, 400)
    const { season, surfaceKind, allianceId, parentId, name, description } = body
    // Wplace's first canvas is season 0; later seasons count up from there.
    const parsedSeason = wholeNumber(season)
    if (parsedSeason === null) {
      return c.json({ error: 'season must be a non-negative integer' }, 400)
    }
    const surface = parseSurface(surfaceKind, allianceId)
    if (surface === null) return c.json({ error: invalidSurface('surfaceKind') }, 400)
    if (parentId !== null && !isUuidV7(parentId)) return c.json({ error: INVALID_PARENT }, 400)
    if (!isName(name)) return c.json({ error: INVALID_NAME }, 400)
    if (
      description !== undefined &&
      (typeof description !== 'string' ||
        description.length === 0 ||
        description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      return c.json({ error: 'description must be 1..4096 characters when provided' }, 400)
    }
    const slug = nodeSlug(name)
    if (slug.length === 0) return c.json({ error: UNSLUGGABLE_NAME }, 400)
    return runBackendHttp(
      c,
      runtime,
      createNode({
        season: parsedSeason,
        surface,
        parentId,
        name,
        slug,
        ...(description === undefined ? {} : { description }),
      }),
      (node) => c.json(node, 201),
    )
  })

  routes.get('/', async (c) => {
    const season = wholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const surface = parseSurface(c.req.query('surface'), c.req.query('allianceId'))
    if (surface === null) return c.json({ error: invalidSurface('surface') }, 400)
    return runBackendHttp(c, runtime, listNodes(season, surface), (nodes) => c.json(nodes))
  })

  routes.patch('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!isUuidV7(nodeId)) return c.json({ error: INVALID_ID }, 400)
    const body = await jsonObject(c)
    if (body === null) return c.json({ error: 'invalid body' }, 400)
    const { name, parentId } = body
    if (name !== undefined && !isName(name)) return c.json({ error: INVALID_NAME }, 400)
    if (parentId !== undefined && parentId !== null && !isUuidV7(parentId)) {
      return c.json({ error: INVALID_PARENT }, 400)
    }
    const empty = emptyPatch({ name, parentId })
    if (empty !== null) return c.json({ error: empty }, 400)
    const rename = name === undefined ? undefined : { name, slug: nodeSlug(name) }
    if (rename !== undefined && rename.slug.length === 0) {
      return c.json({ error: UNSLUGGABLE_NAME }, 400)
    }

    return runBackendHttp(
      c,
      runtime,
      patchNode({
        nodeId,
        ...(rename === undefined ? {} : { rename }),
        ...(parentId === undefined ? {} : { parentId }),
      }),
      (node) => c.json(node),
    )
  })

  routes.get('/:id/subtree', async (c) => {
    const nodeId = c.req.param('id')
    if (!isUuidV7(nodeId)) return c.json({ error: INVALID_ID }, 400)
    return runBackendHttp(c, runtime, countNodeSubtree(nodeId), (counts) => c.json(counts))
  })

  routes.delete('/:id', async (c) => {
    const nodeId = c.req.param('id')
    if (!isUuidV7(nodeId)) return c.json({ error: INVALID_ID }, 400)
    if (c.req.query('cascade') === 'true') {
      const expectedNodes = wholeNumber(c.req.query('expectedNodes'))
      const expectedTemplates = wholeNumber(c.req.query('expectedTemplates'))
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
