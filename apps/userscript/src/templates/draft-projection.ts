import { WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { onAcceptedPaint, onPaintSubmission, type PaintSubmission } from '../paint-requests.js'
import { onTilePixels } from '../pixel-changes.js'
import { serverConnectionIdentity } from '../server-connections.js'
import { serverColourProgressFor } from '../server-status.js'
import { getState, type ServerConnection } from '../settings.js'
import { onTilePixelsEvicted } from '../tile-pixels.js'
import { applyColourProgressDelta } from '../ui/progress.js'
import { type PlacedTemplate, type ServerCopy, templateById } from './catalog.js'
import { pixelAccounting } from './mismatch.js'
import { focusedTemplate } from './nearest.js'
import type {
  TemplateColourProgress,
  TemplateColourProgressDelta,
  TemplateDraftPixelDelta,
} from './progress-types.js'

/**
 * Per-colour progress for one template where Wplace's own paint controls are used.
 *
 * Local overlays have no server and therefore use their retained client scan. Server overlays keep
 * the server as their complete baseline and project only the exact category transfers made by this
 * browser's native draft. This does not depend on an offscreen tile having been scanned locally.
 */
const connectedServers = (): ReadonlyMap<string, ServerConnection> =>
  new Map(getState().servers.map((server) => [server.url, server]))

interface DraftProjection {
  readonly identity: DraftProjectionIdentity
  readonly baselines: Map<number, TemplateColourProgress>
  readonly pending: Map<string, TemplateDraftPixelDelta>
  readonly acceptedActive: Map<string, TemplateDraftPixelDelta>
  readonly rebasedFrom: Map<string, TemplateDraftPixelDelta>
}

interface DraftProjectionIdentity {
  readonly connection: object
  readonly season: number | null
  readonly serverTemplateId: string
  readonly serverVersion: string
}

interface SubmittedDraft {
  readonly templateId: string
  readonly identity: DraftProjectionIdentity
  readonly pixels: readonly TemplateDraftPixelDelta[]
}

const draftProjections = new Map<string, DraftProjection>()
const submittedDrafts = new WeakMap<object, SubmittedDraft>()

const forgetRebasedTile = (tile: { readonly x: number; readonly y: number }): boolean => {
  const prefix = `${tile.x}/${tile.y}/`
  let changed = false
  for (const state of draftProjections.values()) {
    for (const key of state.rebasedFrom.keys()) {
      if (!key.startsWith(prefix)) continue
      state.rebasedFrom.delete(key)
      changed = true
    }
  }
  return changed
}

const projectionIdentity = (
  template: ServerCopy,
  server: ServerConnection,
): DraftProjectionIdentity => ({
  connection: serverConnectionIdentity(server),
  season: server.season,
  serverTemplateId: template.serverTemplateId,
  serverVersion: template.version,
})

const sameProjectionIdentity = (
  left: DraftProjectionIdentity,
  right: DraftProjectionIdentity,
): boolean =>
  left.connection === right.connection &&
  left.season === right.season &&
  left.serverTemplateId === right.serverTemplateId &&
  left.serverVersion === right.serverVersion

const serverCovers = (
  server: TemplateColourProgress,
  target: TemplateColourProgress,
  baseline: TemplateColourProgress,
): boolean => {
  const movement = target.completed - baseline.completed
  return movement > 0
    ? server.completed >= target.completed
    : movement < 0
      ? server.completed <= target.completed
      : true
}

const zeroDelta = (index: number): TemplateColourProgressDelta => ({
  index,
  completed: 0,
  mismatched: 0,
  unpainted: 0,
})

const addDelta = (
  left: TemplateColourProgressDelta,
  right: TemplateColourProgressDelta,
): TemplateColourProgressDelta => ({
  index: left.index,
  completed: left.completed + right.completed,
  mismatched: left.mismatched + right.mismatched,
  unpainted: left.unpainted + right.unpainted,
})

const addPixelDelta = (
  left: TemplateDraftPixelDelta,
  right: TemplateDraftPixelDelta,
): TemplateDraftPixelDelta => ({ ...left, ...addDelta(left, right) })

const subtractPixelDelta = (
  left: TemplateDraftPixelDelta,
  right: TemplateDraftPixelDelta,
): TemplateDraftPixelDelta => ({
  ...left,
  completed: left.completed - right.completed,
  mismatched: left.mismatched - right.mismatched,
  unpainted: left.unpainted - right.unpainted,
})

const deltaIsEmpty = (delta: TemplateColourProgressDelta): boolean =>
  delta.completed === 0 && delta.mismatched === 0 && delta.unpainted === 0

const samePixelBasis = (left: TemplateDraftPixelDelta, right: TemplateDraftPixelDelta): boolean =>
  left.basis === right.basis && left.index === right.index

const samePixelDelta = (left: TemplateDraftPixelDelta, right: TemplateDraftPixelDelta): boolean =>
  left.key === right.key &&
  samePixelBasis(left, right) &&
  left.completed === right.completed &&
  left.mismatched === right.mismatched &&
  left.unpainted === right.unpainted

const aggregateColours = (
  pixels: Iterable<TemplateDraftPixelDelta>,
): ReadonlyMap<number, TemplateColourProgressDelta> => {
  const totals = new Map<number, TemplateColourProgressDelta>()
  for (const pixel of pixels) {
    const index = pixel.index
    totals.set(index, addDelta(totals.get(index) ?? zeroDelta(index), pixel))
  }
  return totals
}

/**
 * Reconcile a draft against the server snapshot that was visible when that colour was first edited.
 * `max(server, projected baseline)` semantics for ordinary corrective painting preserve newer work
 * by other painters and make a status response that includes our paint win without double counting.
 */
const progressWithDrafts = (
  templateId: string,
  identity: DraftProjectionIdentity,
  server: readonly TemplateColourProgress[],
  pixels: readonly TemplateDraftPixelDelta[],
): readonly TemplateColourProgress[] => {
  let state = draftProjections.get(templateId)
  if (state !== undefined && !sameProjectionIdentity(state.identity, identity)) {
    draftProjections.delete(templateId)
    state = undefined
  }
  if (state === undefined) {
    if (pixels.length === 0) return server
    state = {
      identity,
      baselines: new Map(),
      pending: new Map(),
      acceptedActive: new Map(),
      rebasedFrom: new Map(),
    }
    draftProjections.set(templateId, state)
  }
  const rawActive = new Map(pixels.map((pixel) => [pixel.key, pixel]))
  for (const key of [...state.acceptedActive.keys()]) {
    if (!rawActive.has(key)) state.acceptedActive.delete(key)
  }
  const serverByIndex = new Map(server.map((entry) => [entry.index, entry]))
  for (const pixel of [...state.pending.values(), ...rawActive.values()]) {
    const entry = serverByIndex.get(pixel.index)
    const baseline = state.baselines.get(pixel.index)
    if (entry !== undefined && (baseline === undefined || baseline.total !== entry.total))
      state.baselines.set(pixel.index, entry)
  }

  const pendingByColour = aggregateColours(state.pending.values())
  for (const [index, baseline] of [...state.baselines]) {
    const entry = serverByIndex.get(index)
    if (entry === undefined) {
      state.baselines.delete(index)
      for (const [key, pixel] of state.pending) if (pixel.index === index) state.pending.delete(key)
      continue
    }
    const pending = pendingByColour.get(index)
    if (pending === undefined || deltaIsEmpty(pending)) continue
    if (serverCovers(entry, applyColourProgressDelta(baseline, pending), baseline)) {
      for (const [key, pixel] of state.pending) {
        if (pixel.index !== index) continue
        const held = state.rebasedFrom.get(key)
        const rebased =
          held !== undefined && samePixelBasis(held, pixel) ? addPixelDelta(held, pixel) : pixel
        if (deltaIsEmpty(rebased)) state.rebasedFrom.delete(key)
        else state.rebasedFrom.set(key, rebased)
        state.pending.delete(key)
      }
      state.baselines.set(index, entry)
    }
  }

  const active = new Map(
    [...rawActive].map(([key, pixel]) => {
      const rebase = state.rebasedFrom.get(key)
      if (rebase === undefined) return [key, pixel]
      if (samePixelBasis(rebase, pixel)) return [key, subtractPixelDelta(pixel, rebase)]
      state.rebasedFrom.delete(key)
      return [key, pixel]
    }),
  )

  // A current native draft replaces pending work at the same pixel. Once the server has covered an
  // accepted pixel, the still-mounted copy of that same draft is suppressed until Wplace clears it.
  const effective = new Map(state.pending)
  for (const [key, pixel] of active) {
    const accepted = state.acceptedActive.get(key)
    if (!state.pending.has(key) && accepted !== undefined && samePixelDelta(pixel, accepted))
      continue
    effective.set(key, pixel)
  }

  const effectiveByColour = aggregateColours(effective.values())
  const result = server.map((entry) => {
    const delta = effectiveByColour.get(entry.index)
    if (delta === undefined || deltaIsEmpty(delta)) return entry
    const baseline = state.baselines.get(entry.index) ?? entry
    const target = applyColourProgressDelta(baseline, delta)
    return serverCovers(entry, target, baseline) ? entry : target
  })
  if (active.size === 0 && state.pending.size === 0 && state.rebasedFrom.size === 0)
    draftProjections.delete(templateId)
  return result
}

/**
 * A template's per-colour progress. A server's report gets this browser's native draft projected
 * onto it; anything measured here, including every alliance template, reads the accounting as is.
 */
export const projectedColourProgress = (
  template: PlacedTemplate | null,
  servers: ReadonlyMap<string, ServerConnection> = connectedServers(),
): readonly TemplateColourProgress[] => {
  if (template === null) return []
  const accounting = pixelAccounting.read(template)
  if (template.origin !== 'server' || (template.surface ?? WORLD_TEMPLATE_SURFACE).kind !== 'world')
    return accounting.colours
  const server = servers.get(template.server.url)
  if (server === undefined) return []
  // The drawn template already proves the manifest identity and exact pixel total. Depending on the
  // panel's admitted manifest here would make palette counters disappear whenever Paint opened
  // before the main menu had rendered its tree.
  const progress = serverColourProgressFor(server, {
    id: template.serverTemplateId,
    totalPixels: template.opaque,
  })
  return progress === null
    ? []
    : progressWithDrafts(
        template.id,
        projectionIdentity(template, server),
        progress,
        accounting.draftPixelDeltas,
      )
}

const retainAcceptedPixels = (
  state: DraftProjection,
  pixels: readonly TemplateDraftPixelDelta[],
): void => {
  for (const raw of pixels) {
    const rebase = state.rebasedFrom.get(raw.key)
    const pixel =
      rebase !== undefined && samePixelBasis(rebase, raw) ? subtractPixelDelta(raw, rebase) : raw
    if (deltaIsEmpty(pixel)) state.pending.delete(pixel.key)
    else state.pending.set(pixel.key, pixel)
    state.acceptedActive.set(pixel.key, pixel)
  }
}

/** Keep an accepted draft visible while its authoritative status response is still in flight. */
const retainAcceptedDraft = (submission?: PaintSubmission): void => {
  const submitted = submission === undefined ? undefined : submittedDrafts.get(submission.identity)
  const template = submitted === undefined ? focusedTemplate() : templateById(submitted.templateId)
  if (template?.origin !== 'server') return
  const servers = connectedServers()
  const server = servers.get(template.server.url)
  if (server === undefined) return
  const identity = projectionIdentity(template, server)
  if (submitted !== undefined && !sameProjectionIdentity(submitted.identity, identity)) return
  const pixels = submitted?.pixels ?? pixelAccounting.read(template).draftPixelDeltas
  const progress = serverColourProgressFor(server, {
    id: template.serverTemplateId,
    totalPixels: template.opaque,
  })
  if (progress === null) return
  // Populate or fence the projection from the captured submission, even after Wplace cleared it.
  progressWithDrafts(template.id, identity, progress, pixels)
  const state = draftProjections.get(template.id)
  if (state === undefined || !sameProjectionIdentity(state.identity, identity)) return
  retainAcceptedPixels(state, pixels)
}

const snapshotSubmittedDraft = (submission: PaintSubmission): void => {
  const template = focusedTemplate()
  if (template?.origin !== 'server') return
  const servers = connectedServers()
  const server = servers.get(template.server.url)
  if (server === undefined) return
  const pixels = pixelAccounting.read(template).draftPixelDeltas
  if (pixels.length === 0) return
  const identity = projectionIdentity(template, server)
  projectedColourProgress(template, servers)
  submittedDrafts.set(submission.identity, {
    templateId: template.id,
    identity,
    pixels: pixels.map((pixel) => ({ ...pixel })),
  })
}

/**
 * Keep projections current: capture each submitted draft, retain accepted ones until the server
 * reports them, and drop rebased pixels once their tile is re-read. `onChange` hears every change
 * that can move the projected counts.
 */
export const installDraftProjection = (onChange: () => void): void => {
  onPaintSubmission(snapshotSubmittedDraft)
  onTilePixels((tile, triples, source) => {
    if (
      (source === 'server' || source === 'observed') &&
      triples.length > 0 &&
      forgetRebasedTile(tile)
    )
      onChange()
  })
  onTilePixelsEvicted((tile) => {
    if (forgetRebasedTile(tile)) onChange()
  })
  onAcceptedPaint((paint) => {
    const submitted = paint.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
    if (submitted > 0 && paint.painted === submitted) retainAcceptedDraft(paint.submission)
    onChange()
  })
}
