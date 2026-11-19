import type { BoundingBox } from './manifest.js'
import { WORLD_PIXELS } from './tiles.js'

/** The Wplace drawing surface a template is placed on. */
export const TEMPLATE_SURFACE_KINDS = [
  'world',
  'alliance-headquarters',
  'alliance-picture',
  'alliance-banner',
] as const

export type TemplateSurfaceKind = (typeof TEMPLATE_SURFACE_KINDS)[number]
export type AllianceTemplateSurfaceKind = Exclude<TemplateSurfaceKind, 'world'>

export type TemplateSurface =
  | { readonly kind: 'world'; readonly allianceId: null }
  | { readonly kind: AllianceTemplateSurfaceKind; readonly allianceId: number }

export const WORLD_TEMPLATE_SURFACE: TemplateSurface = Object.freeze({
  kind: 'world',
  allianceId: null,
})

export const templateSurface = (kind: unknown, allianceId: unknown): TemplateSurface | null => {
  if (kind === 'world') return allianceId === null ? WORLD_TEMPLATE_SURFACE : null
  if (
    (kind === 'alliance-headquarters' ||
      kind === 'alliance-picture' ||
      kind === 'alliance-banner') &&
    typeof allianceId === 'number' &&
    Number.isSafeInteger(allianceId) &&
    allianceId > 0
  ) {
    return { kind, allianceId }
  }
  return null
}

/** Inclusive minimum and exclusive maximum pixel coordinates accepted by one surface. */
export const templateSurfaceBounds = (surface: TemplateSurface) => {
  switch (surface.kind) {
    case 'world':
      return null
    case 'alliance-headquarters':
      return { minX: -1_000, minY: -1_000, maxX: 1_000, maxY: 1_000 }
    case 'alliance-picture':
      return { minX: 0, minY: 0, maxX: 64, maxY: 64 }
    case 'alliance-banner':
      return { minX: 0, minY: 0, maxX: 384, maxY: 128 }
  }
}

export const sameTemplateSurface = (left: TemplateSurface, right: TemplateSurface): boolean =>
  left.kind === right.kind && left.allianceId === right.allianceId

export const templateSurfaceKey = (surface: TemplateSurface): string =>
  surface.kind === 'world' ? 'world' : `${surface.kind}:${surface.allianceId}`

/** The surface a `templateSurfaceKey` names, or null when the key is not one it produces. */
export const parseTemplateSurfaceKey = (key: string): TemplateSurface | null => {
  const [kind, allianceId] = key.split(':')
  const surface = templateSurface(kind, allianceId === undefined ? null : Number(allianceId))
  return surface !== null && templateSurfaceKey(surface) === key ? surface : null
}

/** A template's painted width and height. A world box wraps through x = 0 when `minX > maxX`. */
export const bboxSize = (
  surface: TemplateSurface,
  bbox: BoundingBox,
): { readonly width: number; readonly height: number } => ({
  width:
    surface.kind === 'world' && bbox.maxX < bbox.minX
      ? WORLD_PIXELS - bbox.minX + bbox.maxX
      : bbox.maxX - bbox.minX,
  height: bbox.maxY - bbox.minY,
})

/**
 * Why `next` cannot be a new version of the template painted at `previous`, or null when it can.
 *
 * A version replaces a template's content in place, and every client keeps its own placement and
 * progress against it, so the dimensions must match. Position may move: that is a re-place.
 */
export const templateSizeChange = (
  surface: TemplateSurface,
  previous: BoundingBox,
  next: BoundingBox,
): string | null => {
  const was = bboxSize(surface, previous)
  const now = bboxSize(surface, next)
  return was.width === now.width && was.height === now.height
    ? null
    : `is ${was.width}x${was.height}, not ${now.width}x${now.height}`
}
