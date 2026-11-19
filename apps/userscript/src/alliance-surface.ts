import {
  type AllianceTemplateSurfaceKind,
  type PixelBounds,
  sameTemplateSurface,
  type TemplateSurface,
  templateSurfaceBounds,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { observePageRequests, type RequestObservation, type RequestRoute } from './page-requests.js'
import { pageWindow } from './page-world.js'
import { frameQueue } from './ui/frame-queue.js'
import { isWplaceMutation } from './ui/wplace-rail.js'
import { OPEN_DIALOG } from './wplace-dom.js'
import { findWplaceLabelled } from './wplace-messages.js'
import { BACKEND_ORIGIN } from './wplace-raster.js'

const EDITOR_STAGE = `${OPEN_DIALOG} [role="application"]`
/** The open alliance editor whose stage carries Wplace's `label`, in the reader's language. */
const stage = (label: 'alliance_hq_canvas' | 'alliance_asset_canvas'): HTMLElement | null =>
  findWplaceLabelled<HTMLElement>(pageWindow().document, EDITOR_STAGE, label)
const ARTBOARD_FRAME = '.artboard-frame'
const DRAFT_CANVAS = /^\/alliance\/assets\/drafts\/(\d+)\/canvas$/
const PUBLIC_HEADQUARTERS = /^\/alliances\/(\d+)\/headquarters(?:\/|$)/

export interface ActiveAllianceSurface {
  readonly surface: Exclude<TemplateSurface, { readonly kind: 'world' }>
  readonly stage: HTMLElement
  readonly frame: HTMLElement
  /** Present when the request observer saw Wplace's disposable picture/banner draft id. */
  readonly draftId: number | null
  /**
   * The artboard's signed, half-open bounds: an HQ's as Wplace supplied them, null until it has;
   * a picture's or banner's fixed size.
   */
  readonly bounds: PixelBounds | null
}

type Listener = (surface: ActiveAllianceSurface | null) => void
type HeadquartersRevisionListener = (allianceId: number) => void

let active: ActiveAllianceSurface | null = null
let installed = false
let observer: MutationObserver | null = null
let stopRequests: (() => void) | null = null
let reconcileQueued = false
let memberAllianceId: number | null = null
let headquarters: {
  readonly allianceId: number
  readonly bounds: PixelBounds | null
  readonly eventHwm: number | null
} | null = null
let draft: {
  readonly id: number
  readonly kind: AllianceTemplateSurfaceKind
} | null = null
let pendingDraft: {
  readonly id: number
  readonly sequence: number
  readonly previousKind: AllianceTemplateSurfaceKind | null
} | null = null
let memberSequence = 0
let acceptedMemberSequence = 0
let headquartersSequence = 0
let acceptedHeadquartersSequence = 0
let draftSequence = 0
let acceptedDraftSequence = 0
let allianceEpoch = 0
const listeners = new Set<Listener>()
const headquartersRevisionListeners = new Set<HeadquartersRevisionListener>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveInteger = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null

const integer = (value: unknown): number | null =>
  Number.isSafeInteger(value) ? Number(value) : null

const nonNegativeInteger = (value: unknown): number | null => {
  const parsed = integer(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

/** Every HQ lies within the largest one Wplace allows. */
const HQ_LIMITS = templateSurfaceBounds({ kind: 'alliance-headquarters', allianceId: 0 })

const parseHqBounds = (value: unknown): PixelBounds | null => {
  if (!isRecord(value) || HQ_LIMITS === null) return null
  const minX = integer(value.minX)
  const minY = integer(value.minY)
  const inclusiveMaxX = integer(value.maxX)
  const inclusiveMaxY = integer(value.maxY)
  if (
    minX === null ||
    minY === null ||
    inclusiveMaxX === null ||
    inclusiveMaxY === null ||
    minX < HQ_LIMITS.minX ||
    minY < HQ_LIMITS.minY ||
    inclusiveMaxX >= HQ_LIMITS.maxX ||
    inclusiveMaxY >= HQ_LIMITS.maxY ||
    minX > inclusiveMaxX ||
    minY > inclusiveMaxY
  ) {
    return null
  }
  return { minX, minY, maxX: inclusiveMaxX + 1, maxY: inclusiveMaxY + 1 }
}

const sameBounds = (left: PixelBounds | null, right: PixelBounds | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.minX === right.minX &&
    left.minY === right.minY &&
    left.maxX === right.maxX &&
    left.maxY === right.maxY)

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

const ASSET_KINDS = ['alliance-picture', 'alliance-banner'] as const

/** The asset whose fixed size Wplace's native artboard canvas has, if any. */
const assetKindFromCanvas = (frame: HTMLElement): AllianceTemplateSurfaceKind | null => {
  for (const child of frame.children) {
    if (child.tagName !== 'CANVAS') continue
    const canvas = child as HTMLCanvasElement
    const kind = ASSET_KINDS.find((candidate) => {
      const bounds = templateSurfaceBounds({ kind: candidate, allianceId: 0 })
      return bounds?.maxX === canvas.width && bounds.maxY === canvas.height
    })
    if (kind !== undefined) return kind
  }
  return null
}

const publish = (next: ActiveAllianceSurface | null): void => {
  if (sameActive(active, next)) return
  active = next
  for (const listener of listeners) {
    try {
      listener(next)
    } catch {
      // Page lifecycle observation must never break Wplace because one consumer failed.
    }
  }
}

const reconcile = (): void => {
  reconcileQueued = false
  const hqStage = stage('alliance_hq_canvas')
  const hqAllianceId = headquarters?.allianceId ?? memberAllianceId
  if (hqStage !== null && hqAllianceId !== null) {
    const frame = hqStage.querySelector<HTMLElement>(ARTBOARD_FRAME)
    if (frame !== null) {
      publish({
        surface: { kind: 'alliance-headquarters', allianceId: hqAllianceId },
        stage: hqStage,
        frame,
        draftId: null,
        bounds: headquarters?.allianceId === hqAllianceId ? headquarters.bounds : null,
      })
      return
    }
  }

  const assetStage = stage('alliance_asset_canvas')
  if (assetStage !== null && memberAllianceId !== null) {
    const frame = assetStage.querySelector<HTMLElement>(ARTBOARD_FRAME)
    if (frame !== null) {
      // Wplace reuses this frame while switching picture and banner. Until the new draft metadata
      // wins, the native canvas can still have the previous asset's dimensions and must not select
      // the previous manifest for the new editor.
      const canvasKind = assetKindFromCanvas(frame)
      if (pendingDraft !== null) {
        if (canvasKind === pendingDraft.previousKind) {
          publish(null)
          return
        }
        if (canvasKind !== null) pendingDraft = null
      }
      // Wplace may reuse a cached draft without issuing the metadata request after a late dev
      // injection. The two asset canvases have fixed, disjoint dimensions, so their native
      // artboard canvas is a safe fallback for kind detection; the request still owns the draft id.
      const kind = draft?.kind ?? canvasKind ?? null
      if (kind === null) {
        publish(null)
        return
      }
      const surface = { kind, allianceId: memberAllianceId }
      publish({
        surface,
        stage: assetStage,
        frame,
        draftId: draft?.kind === kind ? draft.id : null,
        bounds: templateSurfaceBounds(surface),
      })
      return
    }
  }
  publish(null)
}

const queueReconcile = (): void => {
  if (reconcileQueued) return
  reconcileQueued = true
  queueMicrotask(reconcile)
}

const readJson = (response: Response, accept: (body: unknown) => void): void => {
  if (!response.ok) return
  try {
    void response
      .clone()
      .json()
      .then(accept)
      .catch(() => {})
  } catch {
    // A response that cannot be cloned is simply not an observable context source.
  }
}

const observeMemberAlliance = (response: Response, sequence: number): void => {
  readJson(response, (body) => {
    if (sequence < acceptedMemberSequence || !isRecord(body)) return
    const nextAllianceId = positiveInteger(body.id)
    if (nextAllianceId === null) return
    acceptedMemberSequence = sequence
    if (memberAllianceId !== null && memberAllianceId !== nextAllianceId) allianceEpoch++
    if (memberAllianceId !== nextAllianceId) {
      const previous = memberAllianceId
      memberAllianceId = nextAllianceId
      draft = null
      pendingDraft = null
      if (headquarters?.allianceId === previous) headquarters = null
    }
    queueReconcile()
  })
}

const selectHeadquartersRequest = (nextAllianceId: number | null, sequence: number): void => {
  acceptedHeadquartersSequence = sequence
  headquarters =
    nextAllianceId === null
      ? null
      : {
          allianceId: nextAllianceId,
          bounds: headquarters?.allianceId === nextAllianceId ? headquarters.bounds : null,
          eventHwm: headquarters?.allianceId === nextAllianceId ? headquarters.eventHwm : null,
        }
  queueReconcile()
}

const observeHeadquarters = (
  response: Response,
  sequence: number,
  knownAllianceId?: number,
): void => {
  readJson(response, (body) => {
    if (sequence < acceptedHeadquartersSequence || !isRecord(body)) return
    const nextAllianceId = knownAllianceId ?? positiveInteger(body.allianceId)
    if (nextAllianceId === null) return
    acceptedHeadquartersSequence = sequence
    const previous = headquarters
    const bounds = parseHqBounds(body.bounds)
    const eventHwm =
      nonNegativeInteger(body.eventHwm) ??
      (previous?.allianceId === nextAllianceId ? previous.eventHwm : null)
    headquarters = { allianceId: nextAllianceId, bounds, eventHwm }
    queueReconcile()
    if (
      previous?.allianceId === nextAllianceId &&
      sameBounds(previous.bounds, bounds) &&
      eventHwm !== null &&
      eventHwm !== previous.eventHwm
    ) {
      for (const listener of headquartersRevisionListeners) {
        try {
          listener(nextAllianceId)
        } catch {
          // Metadata observation must remain transparent when one refresh consumer fails.
        }
      }
    }
  })
}

const observeDraft = (
  response: Response,
  sequence: number,
  requestedDraftId: number,
  requestAllianceEpoch: number,
): void => {
  if (!response.ok) return
  try {
    void response
      .clone()
      .json()
      .then((body: unknown) => {
        if (
          requestAllianceEpoch !== allianceEpoch ||
          sequence < acceptedDraftSequence ||
          !isRecord(body)
        )
          return
        const responseDraftId =
          body.draftId === undefined ? requestedDraftId : positiveInteger(body.draftId)
        if (responseDraftId !== requestedDraftId) return
        const kind =
          body.assetType === 'picture'
            ? ('alliance-picture' as const)
            : body.assetType === 'banner'
              ? ('alliance-banner' as const)
              : null
        if (kind === null) return
        acceptedDraftSequence = sequence
        draft = { id: requestedDraftId, kind }
        if (pendingDraft?.sequence === sequence) pendingDraft = null
        queueReconcile()
      })
      .catch(() => {})
  } catch {
    // Failed validation deliberately leaves the previous asset kind suppressed.
  }
}

const selectDraftRequest = (id: number): { readonly sequence: number; readonly epoch: number } => {
  const sequence = ++draftSequence
  // Wplace polls the open draft's revision and reloads its canvas after every edit. A draft never
  // changes asset kind, so a request for the draft already in force keeps its surface published;
  // suppressing it would tear the overlay and panel down and remount them on every poll.
  if (draft?.id === id) {
    acceptedDraftSequence = sequence
    return { sequence, epoch: allianceEpoch }
  }
  const previousKind =
    active?.surface.kind === 'alliance-picture' || active?.surface.kind === 'alliance-banner'
      ? active.surface.kind
      : null
  acceptedDraftSequence = sequence
  draft = null
  pendingDraft = { id, sequence, previousKind }
  queueReconcile()
  return { sequence, epoch: allianceEpoch }
}

/** Watch the response, passing it on unchanged. */
const watch = (observe: (response: Response) => void): RequestObservation => ({
  response: (response) => {
    observe(response)
    return response
  },
})

const allianceRoute: RequestRoute = ({ url, realm, fetch }) => {
  if (url.origin !== BACKEND_ORIGIN) return undefined
  const publicHq = PUBLIC_HEADQUARTERS.exec(url.pathname)
  const publicAllianceId = publicHq === null ? null : positiveInteger(Number(publicHq[1]))
  if (publicAllianceId !== null) {
    const sequence = ++headquartersSequence
    selectHeadquartersRequest(publicAllianceId, sequence)
    if (
      url.pathname === `/alliances/${publicAllianceId}/headquarters` ||
      url.pathname === `/alliances/${publicAllianceId}/headquarters/manifest`
    )
      return watch((response) => observeHeadquarters(response, sequence, publicAllianceId))
  }
  if (url.pathname === '/alliance') {
    const sequence = ++memberSequence
    return watch((response) => observeMemberAlliance(response, sequence))
  }
  if (url.pathname === '/alliance/headquarters') {
    const sequence = ++headquartersSequence
    selectHeadquartersRequest(memberAllianceId, sequence)
    return watch((response) => observeHeadquarters(response, sequence))
  }
  const match = DRAFT_CANVAS.exec(url.pathname)
  const id = match === null ? null : positiveInteger(Number(match[1]))
  if (id === null) return undefined
  const { sequence, epoch } = selectDraftRequest(id)
  if (url.searchParams.get('metadataOnly') === 'true')
    return watch((response) => observeDraft(response, sequence, id, epoch))
  // The canvas itself says nothing of its kind; its metadata does, so read that alongside.
  const metadataUrl = new URL(url)
  metadataUrl.searchParams.set('metadataOnly', 'true')
  void fetch.call(realm, metadataUrl.href, { credentials: 'include' }).then(
    (response) => observeDraft(response, sequence, id, epoch),
    () => {
      // Keep the reused canvas unscoped until Wplace proves the new asset kind.
    },
  )
  return undefined
}

/** Install the request and DOM observers at document-start. Idempotent. */
export const installAllianceSurfaceObserver = (): void => {
  if (installed) return
  installed = true
  const realm = pageWindow()
  stopRequests = observePageRequests(allianceRoute)
  // Wplace's DOM churns while the map moves; one reconcile per frame is enough, and our own nodes
  // never open or close an alliance editor.
  const queueFrameReconcile = frameQueue(reconcile, (callback) =>
    realm.requestAnimationFrame(callback),
  )
  observer = new realm.MutationObserver((records) => {
    if (records.some(isWplaceMutation)) queueFrameReconcile()
  })
  observer.observe(realm.document, {
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
 * The middle of an alliance surface, where a new template lands: of the open editor's bounds when
 * it shows that surface, else of the surface's own.
 */
export const allianceSurfaceCentre = (surface: TemplateSurface): { x: number; y: number } => {
  const shown =
    active !== null && sameTemplateSurface(active.surface, surface) ? active.bounds : null
  const bounds = shown ?? templateSurfaceBounds(surface)
  return bounds === null
    ? { x: 0, y: 0 }
    : { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
}

/** The open alliance editor stage, even while its exact asset surface is still being validated. */
export const activeAllianceEditorStage = (): HTMLElement | null =>
  stage('alliance_hq_canvas') ?? stage('alliance_asset_canvas')

export const onActiveAllianceSurfaceChange = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Notify native-pixel consumers when the active HQ advances without changing bounds. */
export const onHeadquartersRevisionChange = (
  listener: HeadquartersRevisionListener,
): (() => void) => {
  headquartersRevisionListeners.add(listener)
  return () => headquartersRevisionListeners.delete(listener)
}

/** Test-only lifecycle reset; harmless when called during teardown in a page. */
export const resetAllianceSurfaceObserver = (): void => {
  observer?.disconnect()
  stopRequests?.()
  observer = null
  stopRequests = null
  installed = false
  reconcileQueued = false
  memberAllianceId = null
  headquarters = null
  draft = null
  pendingDraft = null
  memberSequence = 0
  acceptedMemberSequence = 0
  headquartersSequence = 0
  acceptedHeadquartersSequence = 0
  draftSequence = 0
  acceptedDraftSequence = 0
  allianceEpoch = 0
  active = null
  listeners.clear()
  headquartersRevisionListeners.clear()
}
