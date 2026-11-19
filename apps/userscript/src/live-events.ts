import {
  isRecord,
  type LiveMutationError,
  type LiveProjectionResource,
  type LiveProjectionState,
  type LiveSyncServerEvent,
  type LiveTileOfferCacheResponse,
  type LiveTileOfferResponse,
  MAX_LIVE_PROJECTIONS,
  type TemplateSurface,
  templateSurface,
} from '@caelestis/shared'

/**
 * Decoding of what a live sync server sends. Envelopes are checked here; payloads that need a
 * connection to judge (a manifest against its server's identity, status against its revision) stay
 * `unknown` for the resource that applies them.
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const MAX_PROJECTION_SCOPE_LENGTH = 64

/** A live event that changes what the sync resources hold. */
export type LiveSyncEvent =
  | { readonly type: 'ready' | 'status-reconcile'; readonly revision: number }
  | Extract<LiveSyncServerEvent, { readonly type: 'state-correction' }>
  | {
      readonly type: 'manifest-reconcile'
      /** Null from servers that send no revision: always reconcile. */
      readonly revision: number | null
      /** Null means every surface changed. */
      readonly surface: TemplateSurface | null
    }
  | { readonly type: 'alarms-reconcile' }
  | { readonly type: 'status-delta'; readonly delta: unknown }
  | {
      readonly type: 'manifest-snapshot'
      readonly resource: 'world-manifest' | 'alliance-manifest'
      readonly scope: string
      readonly manifest: unknown
    }
  | { readonly type: 'status-snapshot'; readonly status: unknown }
  | { readonly type: 'alarms-snapshot'; readonly alarms: unknown }

/** What a sync resource may be handed to apply itself. */
export type LiveResourceEvent = Extract<
  LiveSyncEvent,
  { readonly type: 'status-delta' | `${string}-snapshot` }
>

/** The answer to one command this client sent. */
export type LiveCommandResult = Extract<
  LiveSyncServerEvent,
  {
    readonly type: 'paint-result' | 'paint-part-result' | 'tile-offer-result' | 'tile-upload-result'
  }
>

export type LiveEvent =
  | LiveSyncEvent
  | LiveCommandResult
  | Extract<LiveSyncServerEvent, { readonly type: 'tile-offer-cache-result' }>
  | { readonly type: 'dashboard-snapshot' }

type Fields = Record<string, unknown>

const revisionOf = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const LIVE_PROJECTION_RESOURCES: readonly string[] = [
  'world-manifest',
  'alliance-manifest',
  'telemetry-alarms',
] satisfies readonly LiveProjectionResource[]

export const isLiveProjectionResource = (value: string): value is LiveProjectionResource =>
  LIVE_PROJECTION_RESOURCES.includes(value)

type PaintResult = Extract<LiveCommandResult, { readonly type: 'paint-result' }>

const isMutationError = (value: unknown): value is LiveMutationError =>
  value === 'forbidden' || value === 'invalid' || value === 'unavailable'

const mutationError = (value: unknown): value is LiveMutationError | undefined =>
  value === undefined || isMutationError(value)

const paintError = (value: unknown): value is PaintResult['error'] =>
  mutationError(value) || value === 'unsupported' || value === 'too-large'

const paintOutcome = (value: unknown): value is PaintResult['result'] =>
  value === 'recorded' || value === 'partial' || value === 'duplicate'

const stateCorrection = (event: Fields): LiveSyncEvent | null => {
  const revision = revisionOf(event.revision)
  if (
    typeof event.requestId !== 'string' ||
    !UUID_V7.test(event.requestId) ||
    (event.mode !== 'correction' && event.mode !== 'snapshot') ||
    revision === null ||
    !Array.isArray(event.projections) ||
    event.projections.length > MAX_LIVE_PROJECTIONS
  )
    return null
  const projections: LiveProjectionState[] = []
  const keys = new Set<string>()
  for (const projection of event.projections) {
    if (
      !isRecord(projection) ||
      typeof projection.resource !== 'string' ||
      !isLiveProjectionResource(projection.resource) ||
      typeof projection.scope !== 'string' ||
      projection.scope.length === 0 ||
      projection.scope.length > MAX_PROJECTION_SCOPE_LENGTH ||
      (projection.version !== null &&
        (typeof projection.version !== 'string' || !SHA256_HEX.test(projection.version)))
    )
      return null
    const key = `${projection.resource}\u0000${projection.scope}`
    if (keys.has(key)) return null
    keys.add(key)
    projections.push({
      resource: projection.resource,
      scope: projection.scope,
      version: projection.version,
    })
  }
  return {
    type: 'state-correction',
    requestId: event.requestId,
    mode: event.mode,
    revision,
    projections,
  }
}

const manifestReconcile = (event: Fields): LiveSyncEvent | null => {
  const revision = 'revision' in event ? revisionOf(event.revision) : null
  if ('revision' in event && revision === null) return null
  const surface = !('surface' in event)
    ? null
    : isRecord(event.surface)
      ? templateSurface(event.surface.kind, event.surface.allianceId)
      : null
  if ('surface' in event && surface === null) return null
  return { type: 'manifest-reconcile', revision, surface }
}

const tileOfferResponse = (value: unknown): LiveTileOfferResponse | null =>
  isRecord(value) &&
  isStringArray(value.acknowledgedDeliveryIds) &&
  isStringArray(value.rejectedDeliveryIds) &&
  Array.isArray(value.wanted) &&
  value.wanted.every(
    (wanted) =>
      isRecord(wanted) &&
      typeof wanted.deliveryId === 'string' &&
      (wanted.coverageToken === undefined || typeof wanted.coverageToken === 'string'),
  )
    ? {
        acknowledgedDeliveryIds: value.acknowledgedDeliveryIds,
        rejectedDeliveryIds: value.rejectedDeliveryIds,
        wanted: value.wanted.flatMap((wanted) =>
          isRecord(wanted) && typeof wanted.deliveryId === 'string'
            ? [
                {
                  deliveryId: wanted.deliveryId,
                  ...(typeof wanted.coverageToken === 'string'
                    ? { coverageToken: wanted.coverageToken }
                    : {}),
                },
              ]
            : [],
        ),
      }
    : null

const NO_TILE_OFFERS: LiveTileOfferResponse = {
  acknowledgedDeliveryIds: [],
  rejectedDeliveryIds: [],
  wanted: [],
}

const commandResult = (event: Fields, requestId: string): LiveEvent | null => {
  switch (event.type) {
    case 'paint-result': {
      const { result, error } = event
      return typeof event.eventId === 'string' && paintOutcome(result) && paintError(error)
        ? {
            type: 'paint-result',
            requestId,
            eventId: event.eventId,
            result,
            ...(error === undefined ? {} : { error }),
          }
        : null
    }
    case 'paint-part-result':
      return typeof event.eventId === 'string' && Number.isSafeInteger(event.index)
        ? {
            type: 'paint-part-result',
            requestId,
            eventId: event.eventId,
            index: Number(event.index),
          }
        : null
    case 'tile-offer-result': {
      const error = event.error
      if (!mutationError(error)) return null
      // A refusal carries no disposition the client acts on.
      const response =
        tileOfferResponse(event.response) ?? (error === undefined ? null : NO_TILE_OFFERS)
      return response === null
        ? null
        : {
            type: 'tile-offer-result',
            requestId,
            response,
            ...(error === undefined ? {} : { error }),
          }
    }
    case 'tile-upload-result': {
      const error = event.error
      return typeof event.deliveryId === 'string' &&
        typeof event.accepted === 'boolean' &&
        mutationError(error)
        ? {
            type: 'tile-upload-result',
            requestId,
            deliveryId: event.deliveryId,
            accepted: event.accepted,
            ...(error === undefined ? {} : { error }),
          }
        : null
    }
    case 'tile-offer-cache-result': {
      const response = event.response
      if (
        !isRecord(response) ||
        !isStringArray(response.acknowledgedDeliveryIds) ||
        !isStringArray(response.unresolvedDeliveryIds) ||
        (response.error !== undefined &&
          response.error !== 'forbidden' &&
          response.error !== 'invalid')
      )
        return null
      const cacheResponse: LiveTileOfferCacheResponse = {
        acknowledgedDeliveryIds: response.acknowledgedDeliveryIds,
        unresolvedDeliveryIds: response.unresolvedDeliveryIds,
        ...(response.error === undefined ? {} : { error: response.error }),
      }
      return { type: 'tile-offer-cache-result', requestId, response: cacheResponse }
    }
    default:
      return null
  }
}

/** One complete live message as a typed event, or null when it is not one this client knows. */
export const parseLiveEvent = (value: unknown): LiveEvent | null => {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'state-correction':
      return stateCorrection(value)
    case 'manifest-reconcile':
      return manifestReconcile(value)
    case 'ready':
    case 'status-reconcile': {
      const revision = revisionOf(value.revision)
      return revision === null ? null : { type: value.type, revision }
    }
    case 'alarms-reconcile':
      return { type: 'alarms-reconcile' }
    case 'status-delta':
      return value.delta === undefined ? null : { type: 'status-delta', delta: value.delta }
    case 'manifest-snapshot':
      return (value.resource === 'world-manifest' || value.resource === 'alliance-manifest') &&
        typeof value.scope === 'string' &&
        'manifest' in value
        ? {
            type: 'manifest-snapshot',
            resource: value.resource,
            scope: value.scope,
            manifest: value.manifest,
          }
        : null
    case 'status-snapshot':
      return 'status' in value ? { type: 'status-snapshot', status: value.status } : null
    case 'alarms-snapshot':
      return 'alarms' in value ? { type: 'alarms-snapshot', alarms: value.alarms } : null
    case 'dashboard-snapshot':
      return { type: 'dashboard-snapshot' }
    default:
      return typeof value.requestId === 'string' ? commandResult(value, value.requestId) : null
  }
}
