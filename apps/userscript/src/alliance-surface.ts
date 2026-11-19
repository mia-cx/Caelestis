import {
  type PixelBounds,
  sameTemplateSurface,
  type TemplateSurface,
  templateSurfaceBounds,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import {
  createAllianceContext,
  type ResolvedAllianceSurface,
  sameBounds,
} from './alliance-context.js'
import { type AllianceEditorElements, locateAllianceEditors } from './alliance-editor-dom.js'
import { frameQueue } from './frame-queue.js'
import { notifyListeners } from './listeners.js'
import { observePageRequests } from './page-requests.js'
import { pageWindow } from './page-world.js'
import { isWplaceMutation } from './wplace-dom.js'
import { BACKEND_ORIGIN } from './wplace-raster.js'

/** The artboard the open alliance editor shows, with the DOM it is drawn into. */
export type ActiveAllianceSurface = Omit<ResolvedAllianceSurface, 'editor'> & AllianceEditorElements

type Listener = (surface: ActiveAllianceSurface | null) => void

let active: ActiveAllianceSurface | null = null
let installed = false
let reconcileQueued = false
const listeners = new Set<Listener>()

const sameActive = (left: ActiveAllianceSurface | null, right: ActiveAllianceSurface | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.stage === right.stage &&
    left.frame === right.frame &&
    left.surface.kind === right.surface.kind &&
    left.surface.allianceId === right.surface.allianceId &&
    left.draftId === right.draftId &&
    sameBounds(left.bounds, right.bounds))

const publish = (next: ActiveAllianceSurface | null): void => {
  if (sameActive(active, next)) return
  active = next
  notifyListeners(listeners, 'alliance surface listener failed', next)
}

const reconcile = (): void => {
  reconcileQueued = false
  const editors = locateAllianceEditors()
  const resolved = context.resolve(editors.view)
  const elements = resolved === null ? null : editors[resolved.editor]
  if (resolved === null || elements === null) {
    publish(null)
    return
  }
  const { surface, draftId, bounds } = resolved
  publish({ surface, draftId, bounds, ...elements })
}

const queueReconcile = (): void => {
  if (reconcileQueued) return
  reconcileQueued = true
  queueMicrotask(reconcile)
}

const context = createAllianceContext(queueReconcile)

/** Install the request and DOM observers at document-start. Idempotent. */
export const installAllianceSurfaceObserver = (): void => {
  if (installed) return
  installed = true
  const realm = pageWindow()
  observePageRequests(context.route)
  // Wplace's DOM churns while the map moves; one reconcile per frame is enough, and our own nodes
  // never open or close an alliance editor.
  const queueFrameReconcile = frameQueue(reconcile, (callback) =>
    realm.requestAnimationFrame(callback),
  )
  new realm.MutationObserver((records) => {
    if (records.some(isWplaceMutation)) queueFrameReconcile()
  }).observe(realm.document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open', 'aria-label', 'role', 'class'],
  })
  // A late dev injection may have missed Wplace's bootstrap request. One read restores the stable
  // alliance id; signed-out users and users without an alliance simply leave the context unknown.
  void realm.fetch(`${BACKEND_ORIGIN}/alliance`, { credentials: 'include' }).catch(() => undefined)
  queueReconcile()
}

/** The open alliance editor's artboard, with the DOM it is drawn into; null on the world map. */
export const activeAllianceSurface = (): ActiveAllianceSurface | null => active

/** The surface the painter is looking at: the open alliance artboard, or else the world map. */
export const currentSurface = (): TemplateSurface => active?.surface ?? WORLD_TEMPLATE_SURFACE

/**
 * The bounds of an alliance surface: the open editor's when it shows that surface, else the
 * surface's own (an HQ's widest extent until Wplace supplies the real one). Null for the world.
 */
export const allianceSurfaceBounds = (surface: TemplateSurface): PixelBounds | null =>
  (active !== null && sameTemplateSurface(active.surface, surface) ? active.bounds : null) ??
  templateSurfaceBounds(surface)

/** The middle of an alliance surface, where a new template lands. */
export const allianceSurfaceCentre = (surface: TemplateSurface): { x: number; y: number } => {
  const bounds = allianceSurfaceBounds(surface)
  return bounds === null
    ? { x: 0, y: 0 }
    : { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
}

export const onActiveAllianceSurfaceChange = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Notify native-pixel consumers when the active HQ advances without changing bounds. */
export const onHeadquartersRevisionChange = context.onHeadquartersRevision
