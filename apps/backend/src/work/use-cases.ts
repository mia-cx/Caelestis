import {
  MAX_TEMPLATE_CLAIMANTS,
  MAX_WORK_ITEMS,
  type TemplateSurface,
  uuidV7,
  type WorkAction,
  type WorkFields,
  type WorkItem,
  type WorkMutation,
  workClaimants,
} from '@caelestis/shared'
import { Effect } from 'effect'
import type { Caller } from '../auth/middleware.js'
import { type DrawingScope, sameScope } from '../db/scope.js'
import type { NodeStore } from '../nodes/store.js'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import {
  ForbiddenError,
  NotFoundError,
  type StorageError,
  storage,
  ValidationError,
} from '../runtime/errors.js'
import { bestEffort } from '../status-read-model/port.js'
import type { TemplateStore } from '../templates/store.js'
import type { WorkStore } from './store.js'

/** The longest title `isWorkFields` accepts; a template claim takes its template's name. */
const MAX_WORK_TITLE_LENGTH = 160

const invalid = (message: string) => Effect.fail(new ValidationError({ message }))

const activityAction = (action: WorkMutation['action']): WorkAction => {
  switch (action) {
    case 'claim-template':
      return 'claim'
    case 'release-template':
      return 'release'
    case 'assign-template':
      return 'assign'
    case 'unassign-template':
      return 'release'
    default:
      return action
  }
}

/**
 * Which work a caller below admin may see: items whose every linked template is published. Work
 * copies template names and links, so an item linking an unpublished or deleted template would
 * still describe it.
 */
const visibleWork = (sql: TemplateStore, season: number, surface: TemplateSurface) =>
  storage('coordination', async () => {
    const published = new Set(
      (await sql.listManifestTemplates({ season, surface }, false)).map((template) => template.id),
    )
    return (item: WorkItem) => item.templateIds.every((id) => published.has(id))
  })

/** Read a bounded page of work in one drawing scope, ordered by stable ID. */
export const listWork = (
  season: number,
  surface: TemplateSurface,
  after: string,
  includeUnpublished: boolean,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const visible = includeUnpublished ? () => true : yield* visibleWork(sql, season, surface)
    // Clients continue from the last item they were given, so the cursor must name a visible one.
    // Read past pages that are entirely hidden rather than ending early or naming a hidden id.
    let cursor = after
    while (true) {
      const page = yield* storage('coordination', () => sql.work.list(season, surface, cursor))
      const items = page.filter(visible)
      if (page.length < MAX_WORK_ITEMS) return { items, nextCursor: null }
      const last = items.at(-1)
      if (last !== undefined) return { items, nextCursor: last.id }
      cursor = page.at(-1)?.id ?? cursor
    }
  })

/** Read activity newest first, with revision-based pagination. */
export const workHistory = (id: string, before: number, includeUnpublished: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const item = yield* storage('coordination', () => sql.work.read(id))
    const visible = includeUnpublished
      ? () => true
      : item === null
        ? () => false
        : yield* visibleWork(sql, item.season, item.surface)
    if (item === null || !visible(item))
      return yield* Effect.fail(new NotFoundError({ message: 'Work item not found' }))
    const activity = yield* storage('coordination', () => sql.work.history(id, before))
    return activity.filter((entry) => visible(entry.item))
  })

/** The item a mutation addresses, in the drawing scope the route named. */
interface WorkTarget extends DrawingScope {
  readonly id: string
}

type WorkStores = NodeStore & TemplateStore & { readonly work: WorkStore }

/** A mutation whose action one workflow handles. */
type MutationOf<Action extends WorkMutation['action']> = WorkMutation & { readonly action: Action }

interface MutationResult {
  readonly conflict: boolean
  readonly item: WorkItem | null
}

const notFound = Effect.fail(new NotFoundError({ message: 'Work item not found' }))

/** The stored item, refused when it lives in another drawing scope than the request names. */
const readHeld = (sql: WorkStores, target: WorkTarget) =>
  Effect.gen(function* () {
    const held = yield* storage('coordination', () => sql.work.read(target.id))
    if (held !== null && !sameScope(target, held))
      return yield* invalid('Work belongs to a different drawing scope')
    return held
  })

/** Refuse fields linking anything missing or outside the target's scope. Kept links pass as-is. */
const checkFields = (
  sql: WorkStores,
  target: WorkTarget,
  fields: WorkFields,
  held: WorkItem | null,
) =>
  Effect.gen(function* () {
    if (fields.blockerIds.includes(target.id)) return yield* invalid('Work cannot block itself')
    const { nodeId } = fields
    if (nodeId !== null && nodeId !== held?.nodeId) {
      const node = yield* storage('coordination', () => sql.readNode(nodeId))
      if (node === null || !sameScope(target, node))
        return yield* invalid('Folder is missing or belongs to a different drawing scope')
    }
    for (const templateId of fields.templateIds) {
      if (held?.templateIds.includes(templateId)) continue
      const template = yield* storage('coordination', () => sql.readTemplate(templateId))
      if (template === null || !sameScope(target, template))
        return yield* invalid('Linked template is missing or belongs to a different drawing scope')
      if (!template.published)
        return yield* invalid('Publish the template before linking shared work')
    }
    for (const blockerId of fields.blockerIds) {
      const blocker = yield* storage('coordination', () => sql.work.read(blockerId))
      if (blocker === null || !sameScope(target, blocker))
        return yield* invalid('Blocker is missing or belongs to a different drawing scope')
    }
  })

/** Store the next revision and its activity if `held` is still current, then tell readers. */
const saveWork = (
  target: WorkTarget,
  mutation: WorkMutation,
  caller: Caller,
  held: WorkItem | null,
  next: WorkFields &
    Pick<WorkItem, 'claimant'> & { readonly claimants?: WorkItem['claimants'] | undefined },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const live = yield* StatusReadModelService
    const now = Date.now()
    const { claimants } = next
    const item: WorkItem = {
      title: next.title.trim(),
      description: next.description,
      status: next.status,
      priority: next.priority,
      tags: next.tags,
      blockerIds: next.blockerIds,
      nodeId: next.nodeId,
      templateIds: next.templateIds,
      ...target,
      claimant: next.claimant,
      ...(claimants === undefined ? {} : { claimants }),
      revision: (held?.revision ?? 0) + 1,
      createdAt: held?.createdAt ?? now,
      updatedAt: Math.max(held?.updatedAt ?? now, now),
    }
    const activity = {
      id: uuidV7(),
      action: activityAction(mutation.action),
      actor: mutation.actor,
      item,
    }
    const saved = yield* storage('coordination', () =>
      sql.work.save(item, mutation.expectedRevision, activity, caller.tokenHash),
    )
    // A write that lost its revision race changed nothing; the write that won publishes its own.
    if (saved)
      yield* storage('coordination', () =>
        bestEffort(() => live.notifyManifestChange(target.season, target.surface, false)),
      )
    return {
      conflict: !saved,
      item: saved ? item : yield* storage('coordination', () => sql.work.read(target.id)),
    }
  })

/** Administrators plan work: create it, edit its fields, or assign it to one painter. */
const planWork = (
  target: WorkTarget,
  mutation: MutationOf<'create' | 'edit' | 'assign'>,
  caller: Caller,
): Effect.Effect<MutationResult, WorkError, WorkServices> =>
  Effect.gen(function* () {
    if (caller.scope !== 'admin') return yield* Effect.fail(new ForbiddenError())
    const sql = yield* SqlStoreService
    const held = yield* readHeld(sql, target)
    if (mutation.action !== 'create' && held === null) return yield* notFound
    if (
      (held?.revision ?? 0) !== mutation.expectedRevision ||
      (mutation.action === 'create' && held !== null)
    )
      return { conflict: true, item: held }
    const fields = mutation.action === 'assign' ? held : mutation.fields
    if (fields == null) return yield* invalid('Work fields are required')
    yield* checkFields(sql, target, fields, held)
    if (held?.claimants !== undefined && mutation.action !== 'edit')
      return yield* invalid('Use template claim actions for this template')
    const claimant =
      mutation.action === 'assign' ? (mutation.claimant ?? null) : (held?.claimant ?? null)
    return yield* saveWork(target, mutation, caller, held, {
      ...fields,
      claimant,
      claimants: held?.claimants,
    })
  })

/** Painters claim and release shared work as themselves, one claimant at a time. */
const claimSharedWork = (
  target: WorkTarget,
  mutation: MutationOf<'claim' | 'release'>,
  caller: Caller,
): Effect.Effect<MutationResult, WorkError, WorkServices> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const held = yield* readHeld(sql, target)
    if (held === null) return yield* notFound
    if (held.revision !== mutation.expectedRevision) return { conflict: true, item: held }
    yield* checkFields(sql, target, held, held)
    if (held.claimants !== undefined)
      return yield* invalid('Use template claim actions for this template')
    if (mutation.action === 'release') {
      if (held.claimant?.wplaceUserId !== mutation.actor.wplaceUserId)
        return yield* Effect.fail(new ForbiddenError())
      return yield* saveWork(target, mutation, caller, held, { ...held, claimant: null })
    }
    if (held.status === 'completed')
      return yield* invalid('Reopen completed work before claiming it')
    if (held.claimant !== null) return { conflict: true, item: held }
    return yield* saveWork(target, mutation, caller, held, { ...held, claimant: mutation.actor })
  })

/**
 * A template's own claim, keyed by the template's id and created on first use: painters join and
 * leave it as themselves, administrators add or remove another painter. Many painters may hold it.
 */
const claimTemplate = (
  target: WorkTarget,
  mutation: MutationOf<
    'claim-template' | 'release-template' | 'assign-template' | 'unassign-template'
  >,
  caller: Caller,
): Effect.Effect<MutationResult, WorkError, WorkServices> =>
  Effect.gen(function* () {
    const forOther =
      mutation.action === 'assign-template' || mutation.action === 'unassign-template'
    if (forOther && caller.scope !== 'admin') return yield* Effect.fail(new ForbiddenError())
    const leaving =
      mutation.action === 'release-template' || mutation.action === 'unassign-template'
    const person = forOther ? mutation.claimant : mutation.actor
    const sql = yield* SqlStoreService
    const held = yield* readHeld(sql, target)
    const template = yield* storage('coordination', () => sql.readTemplate(target.id))
    if (template === null || !template.published || !sameScope(target, template))
      return yield* invalid('Publish the template before claiming it')
    if (held !== null && (held.templateIds.length !== 1 || held.templateIds[0] !== target.id))
      return yield* invalid('This work item is not a template claim')
    if (person == null) return yield* invalid('A painter is required')
    const previous = held === null ? [] : workClaimants(held)
    const included = previous.some((claim) => claim.wplaceUserId === person.wplaceUserId)
    // Nothing changed, so subscribers are owed nothing.
    if (held !== null && included !== leaving) return { conflict: false, item: held }
    if ((held?.revision ?? 0) !== mutation.expectedRevision) return { conflict: true, item: held }
    const fields: WorkFields = held ?? {
      title: template.name.slice(0, MAX_WORK_TITLE_LENGTH),
      description: '',
      status: 'open',
      priority: 'normal',
      tags: [],
      blockerIds: [],
      nodeId: template.nodeId,
      templateIds: [target.id],
    }
    yield* checkFields(sql, target, fields, held)
    const claimants = leaving
      ? previous.filter((claim) => claim.wplaceUserId !== person.wplaceUserId)
      : [...previous, person]
    if (claimants.length > MAX_TEMPLATE_CLAIMANTS)
      return yield* invalid('This template has reached its claim limit')
    return yield* saveWork(target, mutation, caller, held, {
      ...fields,
      status: 'open',
      claimant: claimants[0] ?? null,
      claimants,
    })
  })

type WorkError = ValidationError | NotFoundError | ForbiddenError | StorageError
type WorkServices = SqlStoreService | StatusReadModelService

/**
 * Apply a scoped mutation. Claim identity is self-reported; server credentials enforce action
 * scope. The route admits report-scope callers only.
 */
export const mutateWork = (
  id: string,
  season: number,
  surface: TemplateSurface,
  mutation: WorkMutation,
  caller: Caller,
): Effect.Effect<MutationResult, WorkError, WorkServices> => {
  const target = { id, season, surface }
  switch (mutation.action) {
    case 'claim':
    case 'release':
      return claimSharedWork(target, { ...mutation, action: mutation.action }, caller)
    case 'claim-template':
    case 'release-template':
    case 'assign-template':
    case 'unassign-template':
      return claimTemplate(target, { ...mutation, action: mutation.action }, caller)
    default:
      return planWork(target, { ...mutation, action: mutation.action }, caller)
  }
}
