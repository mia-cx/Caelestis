import {
  isSha256Hex,
  isUuidV7,
  MAX_NAME_LENGTH,
  MAX_TEMPLATE_SOURCE_BYTES,
  millis,
  parseTemplateRecipe,
  parseWholeNumber,
  type TemplateRecipe,
} from '@caelestis/shared'
import { type Context, Hono } from 'hono'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import type { TemplateAuthoringInput } from '../templates/authoring.js'
import {
  createTemplate,
  deleteTemplate,
  dismissTemplateAlarm,
  patchTemplate,
  readBlob,
  readTemplateRecipe,
  replaceTemplateVersion,
} from '../templates/use-cases.js'
import { parseSurface } from './params.js'

const isValidName = (name: string): boolean => name.length > 0 && name.length <= MAX_NAME_LENGTH

/** Optional authoring parts. A source without its recipe, or the reverse, is refused. */
const authoringParts = async (
  source: unknown,
  recipe: unknown,
): Promise<{ readonly authoring?: TemplateAuthoringInput } | { readonly error: string }> => {
  if (source === undefined && recipe === undefined) return {}
  if (!(source instanceof File) || typeof recipe !== 'string')
    return { error: 'source must be a PNG file part sent with a recipe JSON part' }
  if (source.size > MAX_TEMPLATE_SOURCE_BYTES) return { error: 'source image is too large to keep' }
  let parsed: TemplateRecipe | null
  try {
    parsed = parseTemplateRecipe(JSON.parse(recipe))
  } catch {
    parsed = null
  }
  if (parsed === null) return { error: 'recipe is not a valid template recipe' }
  return { authoring: { source: new Uint8Array(await source.arrayBuffer()), recipe: parsed } }
}

/** The multipart form both upload routes take: a `png` file part and optional authoring parts. */
const readTemplateUpload = async (c: Context) => {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data'))
    return { error: 'content-type must be multipart/form-data' }
  const body = await c.req.parseBody().catch(() => null)
  if (body === null) return { error: 'invalid multipart body' }
  const { png, source, recipe } = body
  if (!(png instanceof File)) return { error: 'png must be a file part' }
  const parts = await authoringParts(source, recipe)
  if ('error' in parts) return parts
  return { body, png: new Uint8Array(await png.arrayBuffer()), ...parts }
}

const INVALID_ID = 'id must be a canonical lowercase UUIDv7'

export const createTemplateRoutes = (runtime: BackendRuntime) => {
  const routes = new Hono()

  routes.delete('/:templateId/alarms/:alarmId', async (c) => {
    const templateId = c.req.param('templateId')
    const alarmId = c.req.param('alarmId')
    if (!isUuidV7(templateId) || !isUuidV7(alarmId)) {
      return c.json({ error: 'templateId and alarmId must be canonical lowercase UUIDv7' }, 400)
    }
    return runBackendHttp(c, runtime, dismissTemplateAlarm(templateId, alarmId), (result) =>
      c.json(result),
    )
  })

  routes.post('/', async (c) => {
    const upload = await readTemplateUpload(c)
    if ('error' in upload) return c.json({ error: upload.error }, 400)
    const { body, png, ...parts } = upload
    const nodeId = body.nodeId ?? null
    if (nodeId !== null && !isUuidV7(nodeId)) {
      return c.json({ error: 'nodeId must be a canonical lowercase UUIDv7 or omitted' }, 400)
    }
    if (typeof body.name !== 'string' || !isValidName(body.name)) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    const surface = parseSurface(body.surfaceKind, body.allianceId)
    if (surface === null) {
      return c.json(
        { error: 'surfaceKind must be world or an alliance surface with a positive allianceId' },
        400,
      )
    }
    return runBackendHttp(
      c,
      runtime,
      createTemplate({
        surface,
        season: body.season,
        nodeId,
        name: body.name,
        // Always a digest, bootstrap included: `templates_created_with_token_check` requires one.
        createdWithToken: c.get('caller').tokenHash,
        originX: body.originX,
        originY: body.originY,
        png,
        ...parts,
      }),
      (result) => c.json(result, 201),
    )
  })

  /**
   * Replace a template's pixels, keeping its identity.
   *
   * A separate route from `POST /` rather than a flag on it, because the two take different inputs:
   * a new template needs somewhere to live and something to be called, and a new version inherits
   * both from the template it belongs to.
   */
  routes.post('/:id/versions', async (c) => {
    const templateId = c.req.param('id')
    if (!isUuidV7(templateId)) return c.json({ error: INVALID_ID }, 400)
    const upload = await readTemplateUpload(c)
    if ('error' in upload) return c.json({ error: upload.error }, 400)
    const { body, png, ...parts } = upload
    return runBackendHttp(
      c,
      runtime,
      replaceTemplateVersion({
        templateId,
        createdWithToken: c.get('caller').tokenHash,
        originX: body.originX,
        originY: body.originY,
        png,
        ...parts,
      }),
      (result) => c.json(result, 201),
    )
  })

  /**
   * Rename, move, publish or unpublish — anything that leaves the pixels alone.
   *
   * A patch of nothing is rejected rather than treated as a no-op: it is always a mistake on the
   * caller's side, and answering 200 would report success for a request that changed nothing.
   */
  routes.patch('/:id', async (c) => {
    const templateId = c.req.param('id')
    if (!isUuidV7(templateId)) return c.json({ error: INVALID_ID }, 400)
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { name, nodeId, published, timelapseFrozen, finished } = body as {
      name?: unknown
      nodeId?: unknown
      published?: unknown
      timelapseFrozen?: unknown
      finished?: unknown
    }

    if (name !== undefined && (typeof name !== 'string' || !isValidName(name))) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    if (nodeId !== undefined && nodeId !== null && !isUuidV7(nodeId)) {
      return c.json({ error: 'nodeId must be a canonical lowercase UUIDv7 or null' }, 400)
    }
    for (const [field, value] of Object.entries({ published, timelapseFrozen, finished })) {
      if (value !== undefined && typeof value !== 'boolean')
        return c.json({ error: `${field} must be a boolean` }, 400)
    }
    if (
      [name, nodeId, published, timelapseFrozen, finished].every((value) => value === undefined)
    ) {
      return c.json(
        {
          error:
            'patch must set at least one of name, nodeId, published, timelapseFrozen, finished',
        },
        400,
      )
    }

    return runBackendHttp(
      c,
      runtime,
      patchTemplate({
        templateId,
        ...(name === undefined ? {} : { name: name as string }),
        ...(nodeId === undefined ? {} : { nodeId: nodeId as string | null }),
        ...(published === undefined ? {} : { published: published as boolean }),
        ...(timelapseFrozen === undefined ? {} : { timelapseFrozen: timelapseFrozen as boolean }),
        ...(finished === undefined ? {} : { finished: finished as boolean }),
      }),
      (result) => c.json(result),
    )
  })

  routes.delete('/:id', async (c) => {
    const templateId = c.req.param('id')
    if (!isUuidV7(templateId)) return c.json({ error: INVALID_ID }, 400)
    const expectedVersion = c.req.query('expectedVersion')
    const expectedUpdatedAt = c.req.query('expectedUpdatedAt')
    if (expectedVersion === undefined && expectedUpdatedAt === undefined) {
      // Released movers cannot identify the revision they copied. Accepting their unguarded cleanup
      // would let a replacement published during that copy be deleted, so fail safely and retain the
      // source until the revision-aware userscript is installed.
      return c.json(
        { error: 'expectedVersion and expectedUpdatedAt are required for template deletion' },
        428,
      )
    }
    const updatedAt = parseWholeNumber(expectedUpdatedAt)
    if (!isUuidV7(expectedVersion) || updatedAt === null) {
      return c.json(
        { error: 'expectedVersion and expectedUpdatedAt must identify the confirmed revision' },
        400,
      )
    }
    return runBackendHttp(
      c,
      runtime,
      deleteTemplate(templateId, { versionId: expectedVersion, updatedAt: millis(updatedAt) }),
      () => c.body(null, 204),
    )
  })

  return routes
}

/**
 * Content-addressed PNGs: template chunks, original template sources (addressed by the
 * `source.sha256` their recipes name), and mirrored canvas tiles.
 */
export const createBlobRoutes = (
  runtime: BackendRuntime,
  namespace: 'chunks' | 'sources' | 'tiles',
) =>
  new Hono().get('/:hash', async (c) => {
    const hash = c.req.param('hash')
    if (!isSha256Hex(hash)) return c.json({ error: `invalid ${namespace} hash` }, 400)
    return runBackendHttp(
      c,
      runtime,
      readBlob(namespace, hash, c.get('caller').canSeeDrafts),
      (bytes) =>
        // `private`, because this route is behind a read scope: a shared cache must not hand one
        // authorised fetch to a later request that carries no Authorization. Every namespace is
        // immutable and content-addressed, so a client may still cache one forever itself.
        c.body(new Uint8Array(bytes), 200, {
          'content-type': 'image/png',
          'cache-control': 'private, max-age=31536000, immutable',
        }),
    )
  })

/** The recipe behind a template version, so a client can export or re-edit its authoring inputs. */
export const createRecipeRoutes = (runtime: BackendRuntime) =>
  new Hono().get('/:versionId', async (c) => {
    const versionId = c.req.param('versionId')
    if (!isUuidV7(versionId)) {
      return c.json({ error: 'versionId must be a canonical lowercase UUIDv7' }, 400)
    }
    return runBackendHttp(
      c,
      runtime,
      readTemplateRecipe(versionId, c.get('caller').canSeeDrafts),
      (result) =>
        // Versions are immutable, so their recipes are too.
        c.json(result, 200, { 'cache-control': 'private, max-age=31536000, immutable' }),
    )
  })
