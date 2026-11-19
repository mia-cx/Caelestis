import {
  isRegionDocument,
  MAX_PRESENCE_REGION_PIXELS,
  type PainterIdentity,
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionClaimRequest,
  regionDocumentBounds,
  regionDocumentPixels,
  satisfiesScope,
  type TemplateSurface,
} from '@caelestis/shared'
import { Effect } from 'effect'
import type { Caller } from '../auth/middleware.js'
import { sameScope } from '../db/scope.js'
import { presenceRectWithinSurface } from '../presence/geometry.js'
import { PresenceService, SqlStoreService } from '../runtime/backend-runtime.js'
import {
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  storage,
  ValidationError,
} from '../runtime/errors.js'
import { ownedRegionIds } from './region-store.js'

export const listRegions = (
  season: number,
  surface: TemplateSurface,
  templateId?: string,
  owner?: { caller: Caller; actorId: number },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const regions = yield* storage('regions', () =>
      sql.regions.listRegions(season, surface, templateId),
    )
    if (owner === undefined) return { regions }
    const owners = yield* storage('regions', () => sql.regions.regionOwners(season, surface))
    return {
      regions,
      ownedRegionIds: ownedRegionIds(owners, {
        tokenHash: owner.caller.tokenHash,
        actorId: owner.actorId,
      }),
      canWrite: satisfiesScope(owner.caller.scope, 'report'),
    }
  })

/**
 * Create a credential-owned claim, or update its content and template hint as owner or admin.
 * The route admits report-scope callers only.
 */
export const putRegion = (
  id: string,
  season: number,
  surface: TemplateSurface,
  request: RegionClaimRequest,
  caller: Caller,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const live = yield* PresenceService
    if (!isRegionDocument(request.document))
      return yield* Effect.fail(new ValidationError({ message: 'Invalid region document' }))
    const rect = regionDocumentBounds(request.document)
    if (rect === null)
      return yield* Effect.fail(
        new ValidationError({ message: 'Region document must contain an added shape' }),
      )
    if (!presenceRectWithinSurface(rect, surface))
      return yield* Effect.fail(
        new ValidationError({ message: 'Region is outside the drawing surface' }),
      )
    if (rect.w * rect.h > MAX_PRESENCE_REGION_PIXELS)
      return yield* Effect.fail(new ValidationError({ message: 'Region area exceeds limit' }))
    const pixels = regionDocumentPixels(request.document)
    if (pixels === null || pixels.count === 0)
      return yield* Effect.fail(new ValidationError({ message: 'Region claims no pixels' }))
    const templateId = request.templateId ?? null
    if (typeof templateId === 'string') {
      const template = yield* storage('regions', () => sql.readTemplate(templateId))
      // One message for all three, so the answer never says that a draft exists.
      if (template === null || !template.published || !sameScope(template, { season, surface }))
        return yield* Effect.fail(
          new ValidationError({
            message: 'Template is missing, unpublished, or belongs to another drawing surface',
          }),
        )
    }
    let region = yield* storage('regions', () => sql.regions.readRegion(id))
    let inserted = false
    if (region === null) {
      const created: RegionClaim = {
        id,
        season,
        surface,
        templateId,
        claimant: request.actor,
        document: request.document,
        rect,
        label: request.label,
        createdAt: Date.now(),
        expiresAt: Date.now() + REGION_CLAIM_TTL_MS,
      }
      inserted = yield* storage('regions', () =>
        sql.regions.createRegion(created, caller.tokenHash),
      )
      region = inserted ? created : yield* storage('regions', () => sql.regions.readRegion(id))
    }
    if (region === null) {
      if (yield* storage('regions', () => sql.regions.isRegionDeleted(id)))
        return yield* Effect.fail(new GoneError({ message: 'Region was deleted' }))
      return yield* Effect.fail(new ConflictError({ message: 'Region changed during save' }))
    }
    if (!sameScope(region, { season, surface }))
      return yield* Effect.fail(new ConflictError({ message: 'Region is already claimed' }))
    if (!inserted)
      region = yield* storage('regions', () =>
        sql.regions.updateRegion(id, request.document, request.label, templateId, {
          tokenHash: caller.tokenHash,
          actorId: request.actor.wplaceUserId,
          admin: caller.scope === 'admin',
        }),
      )
    if (region === null) {
      if (yield* storage('regions', () => sql.regions.isRegionDeleted(id)))
        return yield* Effect.fail(new GoneError({ message: 'Region was deleted' }))
      return yield* Effect.fail(new ForbiddenError())
    }
    yield* storage('regions', () => live(season, surface).publishRegions())
    return region
  })

/**
 * Withdraw this server's replica of a claim, which only its owner may do, or with `withdraw`
 * false clear the claim for good with any write credential. The route admits report-scope callers
 * only.
 */
export const deleteRegion = (
  id: string,
  actor: PainterIdentity,
  caller: Caller,
  withdraw: boolean,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const live = yield* PresenceService
    const region = yield* storage('regions', () => sql.regions.readRegion(id))
    if (region === null)
      return yield* Effect.fail(new NotFoundError({ message: 'Region not found' }))
    const deleted = yield* storage('regions', () =>
      sql.regions.deleteRegion(
        id,
        {
          tokenHash: caller.tokenHash,
          actorId: actor.wplaceUserId,
          admin: caller.scope === 'admin',
        },
        withdraw,
      ),
    )
    if (!deleted) return yield* Effect.fail(new ForbiddenError())
    yield* storage('regions', () => live(region.season, region.surface).publishRegions())
    return { ok: true }
  })
