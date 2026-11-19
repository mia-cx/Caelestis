import {
  type AllianceTemplateSurfaceKind,
  isRecord,
  type PixelBounds,
  type TemplateSurface,
  templateSurfaceBounds,
} from '@caelestis/shared'
import { notifyEach } from './listeners.js'
import type { RequestObservation, RequestRoute } from './page-requests.js'
import { BACKEND_ORIGIN } from './wplace-raster.js'

/**
 * Which alliance artboard Wplace is showing, as far as its own requests tell: the member's alliance,
 * the HQ it loaded with its bounds, and the picture or banner draft it opened. Wplace exposes none
 * of this in the DOM, so it is read from the responses as they pass, with sequence numbers so a
 * slow early reply never overwrites a later one.
 */

const DRAFT_CANVAS = /^\/alliance\/assets\/drafts\/(\d+)\/canvas$/
const PUBLIC_HEADQUARTERS = /^\/alliances\/(\d+)\/headquarters(?:\/|$)/

export type AllianceSurface = Exclude<TemplateSurface, { readonly kind: 'world' }>

/** Which alliance editor has its artboard mounted, as the DOM shows it. */
export interface AllianceEditorView {
  readonly headquarters: boolean
  /** The asset editor, with the asset its native canvas has the size of, if any. */
  readonly asset: { readonly canvasKind: AllianceTemplateSurfaceKind | null } | null
}

/** The artboard an editor shows, and which editor it is in. */
export interface ResolvedAllianceSurface {
  readonly editor: 'headquarters' | 'asset'
  readonly surface: AllianceSurface
  /** Present when the request observer saw Wplace's disposable picture/banner draft id. */
  readonly draftId: number | null
  /**
   * The artboard's signed, half-open bounds: an HQ's as Wplace supplied them, null until it has;
   * a picture's or banner's fixed size.
   */
  readonly bounds: PixelBounds | null
}

export interface AllianceContext {
  /** Observes Wplace's alliance requests; register it with `observePageRequests`. */
  readonly route: RequestRoute
  /** The surface the open editor shows, given what the DOM has mounted. */
  readonly resolve: (view: AllianceEditorView) => ResolvedAllianceSurface | null
  /** Called when the HQ advances without changing bounds. Returns the unsubscribe. */
  readonly onHeadquartersRevision: (listener: (allianceId: number) => void) => () => void
}

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

export const sameBounds = (left: PixelBounds | null, right: PixelBounds | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.minX === right.minX &&
    left.minY === right.minY &&
    left.maxX === right.maxX &&
    left.maxY === right.maxY)

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

/** Watch the response, passing it on unchanged. */
const watch = (observe: (response: Response) => void): RequestObservation => ({
  response: (response) => {
    observe(response)
    return response
  },
})

/** A fresh alliance context; `changed` runs whenever what `resolve` answers may have changed. */
export const createAllianceContext = (changed: () => void): AllianceContext => {
  let memberAllianceId: number | null = null
  let headquarters: {
    readonly allianceId: number
    readonly bounds: PixelBounds | null
    readonly eventHwm: number | null
  } | null = null
  let draft: { readonly id: number; readonly kind: AllianceTemplateSurfaceKind } | null = null
  let pendingDraft: {
    readonly id: number
    readonly sequence: number
    readonly previousKind: AllianceTemplateSurfaceKind | null
  } | null = null
  /** The kind `resolve` last answered, which a newly requested draft may still be showing. */
  let resolvedKind: AllianceSurface['kind'] | null = null
  let memberSequence = 0
  let acceptedMemberSequence = 0
  let headquartersSequence = 0
  let acceptedHeadquartersSequence = 0
  let draftSequence = 0
  let acceptedDraftSequence = 0
  let allianceEpoch = 0
  const revisionListeners = new Set<(allianceId: number) => void>()

  const resolveView = (view: AllianceEditorView): ResolvedAllianceSurface | null => {
    const hqAllianceId = headquarters?.allianceId ?? memberAllianceId
    if (view.headquarters && hqAllianceId !== null) {
      return {
        editor: 'headquarters',
        surface: { kind: 'alliance-headquarters', allianceId: hqAllianceId },
        draftId: null,
        bounds: headquarters?.allianceId === hqAllianceId ? headquarters.bounds : null,
      }
    }
    if (view.asset === null || memberAllianceId === null) return null
    // Wplace reuses the asset frame while switching picture and banner. Until the new draft metadata
    // wins, the native canvas can still have the previous asset's dimensions and must not select
    // the previous manifest for the new editor.
    const { canvasKind } = view.asset
    if (pendingDraft !== null) {
      if (canvasKind === pendingDraft.previousKind) return null
      if (canvasKind !== null) pendingDraft = null
    }
    // Wplace may reuse a cached draft without issuing the metadata request after a late dev
    // injection. The two asset canvases have fixed, disjoint dimensions, so their native
    // artboard canvas is a safe fallback for kind detection; the request still owns the draft id.
    const kind = draft?.kind ?? canvasKind
    if (kind === null) return null
    const surface = { kind, allianceId: memberAllianceId }
    return {
      editor: 'asset',
      surface,
      draftId: draft?.kind === kind ? draft.id : null,
      bounds: templateSurfaceBounds(surface),
    }
  }

  const resolve = (view: AllianceEditorView): ResolvedAllianceSurface | null => {
    const resolved = resolveView(view)
    resolvedKind = resolved?.surface.kind ?? null
    return resolved
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
      changed()
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
    changed()
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
      changed()
      if (
        previous?.allianceId === nextAllianceId &&
        sameBounds(previous.bounds, bounds) &&
        eventHwm !== null &&
        eventHwm !== previous.eventHwm
      ) {
        notifyEach(
          revisionListeners,
          (listener) => listener(nextAllianceId),
          'alliance:revision listener failed',
        )
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
          changed()
        })
        .catch(() => {})
    } catch {
      // Failed validation deliberately leaves the previous asset kind suppressed.
    }
  }

  const selectDraftRequest = (
    id: number,
  ): { readonly sequence: number; readonly epoch: number } => {
    const sequence = ++draftSequence
    // Wplace polls the open draft's revision and reloads its canvas after every edit. A draft never
    // changes asset kind, so a request for the draft already in force keeps its surface published;
    // suppressing it would tear the overlay and panel down and remount them on every poll.
    if (draft?.id === id) {
      acceptedDraftSequence = sequence
      return { sequence, epoch: allianceEpoch }
    }
    const previousKind =
      resolvedKind === 'alliance-picture' || resolvedKind === 'alliance-banner'
        ? resolvedKind
        : null
    acceptedDraftSequence = sequence
    draft = null
    pendingDraft = { id, sequence, previousKind }
    changed()
    return { sequence, epoch: allianceEpoch }
  }

  const route: RequestRoute = ({ url, realm, fetch }) => {
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

  return {
    route,
    resolve,
    onHeadquartersRevision: (listener) => {
      revisionListeners.add(listener)
      return () => revisionListeners.delete(listener)
    },
  }
}
