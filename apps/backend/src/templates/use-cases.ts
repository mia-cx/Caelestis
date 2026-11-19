import {
  isUuidV7,
  type Millis,
  millis,
  parseInteger,
  parseWholeNumber,
  type TemplateSurface,
} from '@caelestis/shared'
import { Effect } from 'effect'
import {
  BlobStoreService,
  PresenceService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import {
  ConflictError,
  fromPort,
  NotFoundError,
  storage,
  ValidationError,
} from '../runtime/errors.js'
import { bestEffort } from '../status-read-model/port.js'
import { readTileBlob } from '../telemetry/tile-blobs.js'
import {
  createStoredTemplate,
  replaceStoredTemplate,
  type TemplateAuthoringInput,
} from './authoring.js'
import type { TemplatePatch } from './store.js'

const notFound = () => Effect.fail(new NotFoundError({ message: 'not found' }))

const readExisting = (templateId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const template = yield* storage('readTemplate', () => sql.readTemplate(templateId))
    return template ?? (yield* notFound())
  })

/** A guarded write changed nothing: the template is gone, or another write got there first. */
const lostRace = (templateId: string) =>
  Effect.gen(function* () {
    yield* readExisting(templateId)
    return yield* Effect.fail(new ConflictError({ message: 'template changed concurrently' }))
  })

/**
 * World origins are canvas pixels, so never negative; alliance canvases are signed. Origins
 * arrive as form text.
 */
const parseOrigin = (surface: TemplateSurface, x: unknown, y: unknown) => {
  const signed = surface.kind !== 'world'
  const parse = signed ? parseInteger : parseWholeNumber
  const originX = parse(x)
  const originY = parse(y)
  if (originX !== null && originY !== null) return Effect.succeed({ originX, originY })
  return Effect.fail(
    new ValidationError({
      message: signed
        ? 'originX and originY must be integers'
        : 'originX and originY must be non-negative integers',
    }),
  )
}

/**
 * What a committed change means for everyone else, and therefore whom to tell:
 * - `created`: manifests list a new template.
 * - `pixels`: a new version changed the tiles it covers, so the status projection is repaired.
 * - `publication`: it became visible or invisible (deletion included), so presence region hints
 *   are re-sent as well.
 * - `metadata`: names and folders, which leave tile coverage alone.
 */
type TemplateChange = 'created' | 'pixels' | 'publication' | 'metadata'

const afterTemplateChange = (
  template: { readonly season: number; readonly surface: TemplateSurface },
  change: TemplateChange,
) =>
  Effect.gen(function* () {
    const statusReadModel = yield* StatusReadModelService
    if (change === 'pixels' || change === 'publication')
      yield* Effect.promise(() =>
        bestEffort(() => statusReadModel.applyCommittedChange(template.season)),
      )
    if (change === 'publication') {
      // Presence carries region hints only for published templates; a failed send never undoes
      // the change it follows.
      const presence = yield* PresenceService
      yield* Effect.promise(() =>
        presence(template.season, template.surface).publishRegions().catch(console.error),
      )
    }
    yield* Effect.promise(() =>
      bestEffort(() =>
        statusReadModel.notifyManifestChange(
          template.season,
          template.surface,
          change !== 'metadata',
        ),
      ),
    )
  })

/** Dismiss only the episode the admin saw; future loss starts a fresh episode. */
export const dismissTemplateAlarm = (templateId: string, alarmId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const template = yield* readExisting(templateId)
    const dismissed = yield* storage('dismissTemplateAlarm', () =>
      sql.dismissTemplateAlarm(templateId, alarmId, millis(Date.now())),
    )
    if (!dismissed)
      return yield* Effect.fail(
        new ConflictError({ message: 'That grief alert has changed; refresh and try again.' }),
      )
    const readModel = yield* StatusReadModelService
    yield* Effect.promise(() => bestEffort(() => readModel.notifyAlarmChange(template.season)))
    return { ok: true as const }
  })

export interface CreateTemplateInput {
  readonly surface: TemplateSurface
  /** Form text; required for a root template, and inherited from the folder otherwise. */
  readonly season: unknown
  readonly nodeId: string | null
  readonly name: string
  readonly createdWithToken: string
  readonly originX: unknown
  readonly originY: unknown
  readonly png: Uint8Array
  readonly authoring?: TemplateAuthoringInput
}

export const createTemplate = (input: CreateTemplateInput) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const season = yield* templateSeason(input.season, input.nodeId)
    const { originX, originY } = yield* parseOrigin(input.surface, input.originX, input.originY)
    const stored = yield* fromPort('createTemplate', () =>
      createStoredTemplate(blobs, sql, {
        surface: input.surface,
        season,
        nodeId: input.nodeId,
        name: input.name,
        createdWithToken: input.createdWithToken,
        // No wplace session on this route: an admin uploads with a token and nothing else.
        createdByUserId: null,
        originX,
        originY,
        png: input.png,
        ...(input.authoring === undefined ? {} : { authoring: input.authoring }),
      }),
    )
    yield* afterTemplateChange({ season, surface: input.surface }, 'created')
    return stored
  })

/** A root template names its season; one in a folder takes the folder's. */
const templateSeason = (raw: unknown, nodeId: string | null) =>
  Effect.gen(function* () {
    if (raw !== undefined) {
      const season = parseWholeNumber(raw)
      if (season !== null) return season
      return yield* Effect.fail(
        new ValidationError({ message: 'season must be a non-negative integer' }),
      )
    }
    if (nodeId === null)
      return yield* Effect.fail(
        new ValidationError({
          message: 'season must be a non-negative integer for a root template',
        }),
      )
    const sql = yield* SqlStoreService
    const parent = yield* storage('readNode', () => sql.readNode(nodeId))
    if (parent === null)
      return yield* Effect.fail(new ValidationError({ message: `node does not exist: ${nodeId}` }))
    return parent.season
  })

/**
 * Replace a template's pixels, keeping its identity. Origin is per version: moving a template on
 * the canvas is a new slicing.
 */
export const replaceTemplateVersion = (input: {
  readonly templateId: string
  readonly createdWithToken: string
  readonly originX: unknown
  readonly originY: unknown
  readonly png: Uint8Array
  readonly authoring?: TemplateAuthoringInput
}) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const existing = yield* readExisting(input.templateId)
    const { originX, originY } = yield* parseOrigin(existing.surface, input.originX, input.originY)
    const stored = yield* fromPort('replaceTemplateVersion', () =>
      replaceStoredTemplate(blobs, sql, input.templateId, {
        surface: existing.surface,
        createdWithToken: input.createdWithToken,
        createdByUserId: null,
        originX,
        originY,
        png: input.png,
        ...(input.authoring === undefined ? {} : { authoring: input.authoring }),
      }),
    )
    yield* afterTemplateChange(existing, 'pixels')
    return stored
  })

export interface PatchTemplateInput {
  readonly templateId: string
  readonly name?: string
  readonly nodeId?: string | null
  readonly published?: boolean
  readonly timelapseFrozen?: boolean
  readonly finished?: boolean
}

/**
 * Rename, move, publish, freeze or finish a template. A finished template's timelapse is frozen:
 * finishing freezes it, and thawing needs the template reopened first.
 */
export const patchTemplate = (input: PatchTemplateInput) =>
  Effect.gen(function* () {
    if (input.finished === true && input.timelapseFrozen === false)
      return yield* Effect.fail(
        new ValidationError({ message: 'a finished template must keep its timelapse frozen' }),
      )
    const sql = yield* SqlStoreService
    const existing = yield* readExisting(input.templateId)
    const frozen = input.finished === true ? true : input.timelapseFrozen
    if (frozen === false && input.finished !== false && existing.finished === true)
      return yield* Effect.fail(
        new ValidationError({ message: 'reopen the template before thawing its timelapse' }),
      )

    const now = millis(Date.now())
    const patch: TemplatePatch = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      ...(input.published === undefined ? {} : { publishedAt: input.published ? now : null }),
      ...(input.finished === undefined ? {} : { finishedAt: input.finished ? now : null }),
      ...(frozen === undefined ? {} : { timelapseFrozenAt: frozen ? now : null }),
    }
    // A folder the template moves into is input, so a missing one is a bad request.
    const updated = yield* fromPort(
      'updateTemplate',
      () => sql.updateTemplate(input.templateId, patch, now),
      { 'not-found': 'invalid' },
    )
    if (!updated) return yield* lostRace(input.templateId)
    yield* afterTemplateChange(existing, input.published === undefined ? 'metadata' : 'publication')

    return {
      id: input.templateId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      ...(input.published === undefined ? {} : { published: input.published }),
      ...(input.finished === undefined
        ? {}
        : { finished: input.finished, finishedAt: input.finished ? now : null }),
      ...(frozen === undefined ? {} : { timelapseFrozen: frozen }),
      updatedAt: now,
    }
  })

/** Delete exactly the revision the caller confirmed; a newer one wins and the delete is refused. */
export const deleteTemplate = (
  templateId: string,
  expected: { readonly versionId: string; readonly updatedAt: Millis },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const existing = yield* readExisting(templateId)
    const deleted = yield* storage('deleteTemplate', () => sql.deleteTemplate(templateId, expected))
    if (!deleted) return yield* lostRace(templateId)
    yield* afterTemplateChange(existing, 'publication')
  })

/**
 * The version a read names, or the template's current one, once the caller may see the template.
 * An unpublished template answers as though it did not exist.
 */
export const readVisibleVersion = (
  templateId: string,
  versionId: string | undefined,
  includeUnpublished: boolean,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const template = yield* storage('readTemplate', () => sql.readTemplate(templateId))
    if (template === null || (!includeUnpublished && !template.published))
      return yield* Effect.fail(new NotFoundError({ message: 'Template not found.' }))
    const version = versionId ?? template.currentVersionId
    if (version === null || !isUuidV7(version))
      return yield* Effect.fail(new ValidationError({ message: 'Invalid template version.' }))
    const record = yield* storage('readTemplateVersion', () => sql.readTemplateVersion(version))
    if (record?.templateId !== templateId)
      return yield* Effect.fail(new NotFoundError({ message: 'Template version not found.' }))
    return version
  })

/**
 * The recipe behind one immutable version. Processed-only versions have none, and an unpublished
 * template's recipes are admin-only.
 */
export const readTemplateRecipe = (versionId: string, includeUnpublished: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const version = yield* storage('readTemplateVersion', () => sql.readTemplateVersion(versionId))
    if (version?.recipe === undefined) return yield* notFound()
    if (!includeUnpublished) {
      const template = yield* storage('readTemplate', () => sql.readTemplate(version.templateId))
      if (template?.published !== true) return yield* notFound()
    }
    return { templateId: version.templateId, versionId, recipe: version.recipe }
  })

/**
 * A blob's bytes. Chunks and sources that only unpublished templates name answer 404 unless
 * `includeUnpublished`, the same as if they were absent; mirrored canvas tiles are always public.
 */
export const readBlob = (
  namespace: 'chunks' | 'sources' | 'tiles',
  hash: string,
  includeUnpublished: boolean,
) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    if (namespace !== 'tiles' && !includeUnpublished) {
      const published = yield* storage('isPublishedArtwork', () =>
        sql.isPublishedArtwork(namespace, hash),
      )
      if (!published) return yield* notFound()
    }
    const bytes = yield* storage(`read ${namespace} blob`, () =>
      namespace === 'tiles' ? readTileBlob({ blobs, sql }, hash) : blobs.get(namespace, hash),
    )
    return bytes ?? (yield* notFound())
  })
