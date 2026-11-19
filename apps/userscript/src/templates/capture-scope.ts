import {
  sameTemplateSurface,
  TILE_SIZE,
  type TileCoord,
  type TileKey,
  tileKey,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { notifyEach } from '../page-hooks.js'
import { getState, type State } from '../settings.js'
import {
  displayTemplates,
  isTemplateDraft,
  isTemplateVisible,
  type PlacedTemplate,
} from './catalog.js'
import { horizontalSpans } from './placement.js'
import { serverNodesRevision } from './server-nodes.js'
import { type TemplateTileKey, templatePrefix, templateTileKey, tileOf } from './template-tile.js'
import { measuresLocally } from './wplace-owned.js'

/**
 * Which Wplace tiles the browser must read pixels for: the tiles each visible locally measured
 * template covers, plus hidden template tiles that progress explicitly asked for.
 */

// The editor's draft changes with every setting and has no progress worth scanning.
export const isWorldTemplate = (template: PlacedTemplate): boolean =>
  !isTemplateDraft(template) &&
  sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, WORLD_TEMPLATE_SURFACE)

export const worldTemplates = (): readonly PlacedTemplate[] =>
  displayTemplates().filter(isWorldTemplate)

/** Hidden local-template tiles whose pixels were explicitly requested by a progress consumer. */
const pendingProgressPixels = new Set<TemplateTileKey>()

/** Ask capture for one template tile's pixels. True when the scope grew. */
export const requestProgressPixels = (key: TemplateTileKey): boolean => {
  if (pendingProgressPixels.has(key)) return false
  pendingProgressPixels.add(key)
  return true
}

/** The tile's pixels arrived, or are no longer wanted. */
export const settleProgressPixels = (key: TemplateTileKey): void => {
  pendingProgressPixels.delete(key)
}

export const forgetProgressPixels = (templateId: string): void => {
  const prefix = templatePrefix(templateId)
  for (const key of [...pendingProgressPixels]) {
    if (key.startsWith(prefix)) pendingProgressPixels.delete(key)
  }
}

/**
 * Whether anything currently wants to know what disagrees on this tile. Whether anything wants any
 * tile is `captureScopeTiles()` being non-empty.
 *
 * Kept here rather than worked out at draw time so it can be answered before the first frame. The
 * tiles on screen at load are decoded exactly once, and if capture is not on by then we miss all of
 * them and have to read every one back from a preview later — paying twice for pixels that went
 * past us while we were not looking.
 */
export const wantsTilePixels = (tile: TileCoord): boolean => {
  // A server template's marker list comes from its server mismatch mask and its progress comes
  // from telemetry. Capturing the underlying Wplace tile as a fallback makes every newly visible
  // tile perform a million-pixel canvas read during a pan, precisely when the map needs its frame
  // budget most. Local and Wplace-owned templates have neither server source, so they keep
  // exact-pixel capture for both mismatch markers and progress (including when their marker
  // switches are off).
  const templates = worldTemplates().filter(measuresLocally)
  const left = tile.x * TILE_SIZE
  const top = tile.y * TILE_SIZE
  return templates.some((template) => {
    if (pendingProgressPixels.has(templateTileKey(template.id, tile))) return true
    return (
      isTemplateVisible(template) &&
      template.originY < top + TILE_SIZE &&
      template.originY + template.height > top &&
      horizontalSpans(template).some(
        (span) => span.worldStart < left + TILE_SIZE && span.worldEnd > left,
      )
    )
  })
}

const captureScopeListeners = new Set<() => void>()

/** Tell capture its scope grew. One throwing listener must not stop the others. */
export const announceCaptureScope = (): void =>
  notifyEach(
    captureScopeListeners,
    (listener) => listener(),
    'mismatch:capture-scope-listener-failed',
  )

/** Notified synchronously when progress adds a tile to what capture wants. */
export const onCaptureScopeChange = (listener: () => void): (() => void) => {
  captureScopeListeners.add(listener)
  return () => captureScopeListeners.delete(listener)
}

/**
 * Whether each template object is in capture's scope, for as long as nothing visibility reads has
 * changed. Templates and state are replaced, never mutated, and server folders bump a revision, so
 * a template object answers once per state. Visibility allocates for Wplace-owned templates, and
 * the studio's draft and a move preview make a new template list every frame; this keeps both off
 * a quiet frame. Only a template object seen for the first time pays, such as a moving preview.
 */
let scopeEpoch: {
  readonly state: State
  readonly nodes: number
  readonly answers: WeakMap<PlacedTemplate, boolean>
} | null = null

const inCaptureScope = (template: PlacedTemplate): boolean => {
  const state = getState()
  const nodes = serverNodesRevision()
  if (scopeEpoch?.state !== state || scopeEpoch.nodes !== nodes)
    scopeEpoch = { state, nodes, answers: new WeakMap() }
  const known = scopeEpoch.answers.get(template)
  if (known !== undefined) return known
  const answer =
    isWorldTemplate(template) && measuresLocally(template) && isTemplateVisible(template)
  scopeEpoch.answers.set(template, answer)
  return answer
}

const samePlacement = (a: PlacedTemplate, b: PlacedTemplate): boolean =>
  a.id === b.id &&
  a.originX === b.originX &&
  a.originY === b.originY &&
  a.width === b.width &&
  a.height === b.height &&
  a.wrapX === b.wrapX

/** What `scopeTiles` was built from: the in-scope templates in order, and the pending keys. */
let scopeTemplates: readonly PlacedTemplate[] = []
const scopePending = new Set<string>()
let scopeTiles: ReadonlySet<TileKey> = new Set()

/** Compared field by field, so a frame where nothing moved allocates nothing. */
const scopeUnchanged = (templates: readonly PlacedTemplate[]): boolean => {
  let index = 0
  for (const template of templates) {
    if (!inCaptureScope(template)) continue
    const before = scopeTemplates[index++]
    if (before === undefined || !samePlacement(before, template)) return false
  }
  if (index !== scopeTemplates.length || scopePending.size !== pendingProgressPixels.size)
    return false
  for (const key of pendingProgressPixels) if (!scopePending.has(key)) return false
  return true
}

/**
 * Every world tile `wantsTilePixels(tile)` currently answers yes for.
 *
 * Built from the same two sources, so the two cannot drift: each hidden template tile that progress
 * asked for, and the tiles each visible local template covers at its position. A tile entering
 * means pixels kept from before may not describe what it needs, and that tile is re-read. Returns
 * the same set until one of those changes, so it is cheap to ask every frame.
 */
export const captureScopeTiles = (): ReadonlySet<TileKey> => {
  // Not `worldTemplates()`: its filtered copy would be the one allocation left on an idle frame.
  const templates = displayTemplates()
  if (scopeUnchanged(templates)) return scopeTiles
  scopeTemplates = templates.filter(inCaptureScope)
  scopePending.clear()
  const tiles = new Set<TileKey>()
  for (const key of pendingProgressPixels) {
    scopePending.add(key)
    const tile = tileOf(key)
    if (tile !== null) tiles.add(tileKey(tile))
  }
  for (const template of scopeTemplates) {
    const bottom = template.originY + template.height
    for (const span of horizontalSpans(template)) {
      for (let x = Math.floor(span.worldStart / TILE_SIZE); x * TILE_SIZE < span.worldEnd; x++) {
        for (let y = Math.floor(template.originY / TILE_SIZE); y * TILE_SIZE < bottom; y++) {
          tiles.add(tileKey({ x, y }))
        }
      }
    }
  }
  scopeTiles = tiles
  return tiles
}
