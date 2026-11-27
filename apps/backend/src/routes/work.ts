import {
  isUuidV7,
  isWorkFields,
  isWorkIdentity,
  MAX_RASTER_BITS,
  MAX_REGION_ITEMS,
  parseWholeNumber,
  satisfiesScope,
  type WorkMutation,
} from '@caelestis/shared'
import { RegionClaimRequest } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { Hono } from 'hono'
import { requireScope } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { deleteRegion, listRegions, putRegion } from '../work/regions.js'
import { listWork, mutateWork, workHistory } from '../work/use-cases.js'
import { readBoundedText } from './body.js'
import { parseSurface } from './params.js'

/** A work or region document without its masks. */
const MAX_DOCUMENT_BYTES = 16_384
/** The document budget plus room for every item's largest packed mask. */
const MAX_REGION_REQUEST_BYTES =
  MAX_DOCUMENT_BYTES + MAX_REGION_ITEMS * Math.ceil(Math.ceil(MAX_RASTER_BITS / 8) / 3) * 4

/** The drawing scope a work request names in its query. */
const querySurface = (request: { query(name: string): string | undefined }) =>
  parseSurface(request.query('surface'), request.query('allianceId'))

const parseMutation = (body: unknown): WorkMutation | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  const { action, actor, expectedRevision, fields, claimant } = value
  if (
    !isWorkIdentity(actor) ||
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  )
    return null
  if (action === 'create' || action === 'edit')
    return isWorkFields(fields) ? { action, actor, expectedRevision, fields } : null
  if (
    action === 'claim' ||
    action === 'release' ||
    action === 'claim-template' ||
    action === 'release-template'
  )
    return { action, actor, expectedRevision }
  if ((action === 'assign-template' || action === 'unassign-template') && isWorkIdentity(claimant))
    return { action, actor, expectedRevision, claimant }
  if (action === 'assign' && (claimant === null || isWorkIdentity(claimant)))
    return { action, actor, expectedRevision, claimant }
  return null
}

/** Parse a bounded JSON body, or say why it was refused. */
const readJson = async (
  request: Request,
  limit: number,
  tooLarge: string,
): Promise<{ readonly body: unknown } | { readonly error: string; readonly status: 400 | 413 }> => {
  const text = await readBoundedText(request, limit)
  if (text === null) return { error: tooLarge, status: 413 }
  try {
    return { body: JSON.parse(text) }
  } catch {
    return { error: 'Invalid JSON', status: 400 }
  }
}

/**
 * Shared coordination routes, under a `read` mount. Read-only frontend proxy credentials never
 * authorize mutations, which require `report`. An event server (`claims: false`) takes no claims.
 */
export const createWorkRoutes = (runtime: BackendRuntime, { claims }: { claims: boolean }) => {
  const routes = new Hono()
  routes.get('/regions', async (c) => {
    const season = parseWholeNumber(c.req.query('season'))
    const surface = querySurface(c.req)
    const templateId = c.req.query('templateId')
    const actorId = c.req.query('painterId')
    if (
      season === null ||
      surface === null ||
      (actorId !== undefined && parseWholeNumber(actorId) === null) ||
      (templateId !== undefined && !isUuidV7(templateId))
    )
      return c.json({ error: 'Invalid drawing scope or template ID' }, 400)
    return runBackendHttp(
      c,
      runtime,
      listRegions(
        season,
        surface,
        templateId,
        actorId === undefined ? undefined : { caller: c.get('caller'), actorId: Number(actorId) },
      ),
      (snapshot) => c.json(snapshot),
    )
  })
  routes.put('/regions/:id', requireScope('report'), async (c) => {
    if (!claims) return c.json({ error: 'This event server takes no claims' }, 403)
    const id = c.req.param('id')
    const season = parseWholeNumber(c.req.query('season'))
    const surface = querySurface(c.req)
    if (!isUuidV7(id) || season === null || surface === null)
      return c.json({ error: 'Invalid region ID or drawing scope' }, 400)
    const read = await readJson(c.req.raw, MAX_REGION_REQUEST_BYTES, 'Region request is too large')
    if ('error' in read) return c.json({ error: read.error }, read.status)
    let request: Schema.Schema.Type<typeof RegionClaimRequest>
    try {
      request = Schema.decodeUnknownSync(RegionClaimRequest)(read.body)
    } catch {
      return c.json({ error: 'Invalid region request' }, 400)
    }
    return runBackendHttp(
      c,
      runtime,
      putRegion(id, season, surface, request, c.get('caller')),
      (region) => c.json(region),
    )
  })
  routes.delete('/regions/:id', requireScope('report'), async (c) => {
    const id = c.req.param('id')
    if (!isUuidV7(id)) return c.json({ error: 'Invalid region ID' }, 400)
    const read = await readJson(c.req.raw, MAX_DOCUMENT_BYTES, 'Region request is too large')
    if ('error' in read) return c.json({ error: read.error }, read.status)
    const { body } = read
    if (
      typeof body !== 'object' ||
      body === null ||
      !('actor' in body) ||
      !isWorkIdentity(body.actor)
    )
      return c.json({ error: 'Invalid painter identity' }, 400)
    if ('withdraw' in body && typeof body.withdraw !== 'boolean')
      return c.json({ error: 'Invalid withdrawal flag' }, 400)
    return runBackendHttp(
      c,
      runtime,
      // Legacy clients use DELETE for routing cleanup too. Only explicit intent is terminal.
      deleteRegion(
        id,
        body.actor,
        c.get('caller'),
        !('withdraw' in body) || body.withdraw === true,
      ),
      (result) => c.json(result),
    )
  })
  routes.get('/', async (c) => {
    const season = parseWholeNumber(c.req.query('season'))
    const surface = querySurface(c.req)
    if (season === null || surface === null) return c.json({ error: 'Invalid drawing scope' }, 400)
    const caller = c.get('caller')
    const after = c.req.query('after') ?? ''
    if (after !== '' && !isUuidV7(after)) return c.json({ error: 'Invalid work cursor' }, 400)
    return runBackendHttp(
      c,
      runtime,
      listWork(season, surface, after, caller.canSeeDrafts),
      ({ items, nextCursor }) =>
        c.json({
          items,
          canPlan: satisfiesScope(caller.scope, 'admin'),
          canClaim: satisfiesScope(caller.scope, 'report'),
          nextCursor,
        }),
    )
  })
  routes.get('/:id/history', async (c) => {
    const id = c.req.param('id')
    const before =
      c.req.query('before') === undefined
        ? Number.MAX_SAFE_INTEGER
        : parseWholeNumber(c.req.query('before'))
    if (!isUuidV7(id) || before === null) return c.json({ error: 'Invalid history cursor' }, 400)
    return runBackendHttp(
      c,
      runtime,
      workHistory(id, before, c.get('caller').canSeeDrafts),
      (activity) => c.json(activity),
    )
  })
  routes.put('/:id', requireScope('report'), async (c) => {
    const id = c.req.param('id')
    const season = parseWholeNumber(c.req.query('season'))
    const surface = querySurface(c.req)
    if (!isUuidV7(id) || season === null || surface === null)
      return c.json({ error: 'Invalid work ID or drawing scope' }, 400)
    const read = await readJson(c.req.raw, MAX_DOCUMENT_BYTES, 'Work request is too large')
    if ('error' in read) return c.json({ error: read.error }, read.status)
    const mutation = parseMutation(read.body)
    if (mutation === null) return c.json({ error: 'Invalid work action, identity, or fields' }, 400)
    return runBackendHttp(
      c,
      runtime,
      mutateWork(id, season, surface, mutation, c.get('caller')),
      (result) => {
        if (!result.conflict) return c.json(result.item)
        const claimant = result.item?.claimant
        return c.json(
          {
            error:
              claimant === null || claimant === undefined
                ? 'Work changed. Review the current item and retry.'
                : `Claimed by ${claimant.displayName} #${claimant.wplaceUserId}. Review the current item.`,
            item: result.item,
          },
          409,
        )
      },
    )
  })
  return routes
}
