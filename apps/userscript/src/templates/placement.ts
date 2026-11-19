import {
  type TemplateSurface,
  templateSurfaceBounds,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'

/** Where a template sits, without its pixels. */
export interface Placement {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  readonly surface?: TemplateSurface
  readonly wrapX?: boolean
  readonly serverUrl?: string
}

/**
 * Throw a RangeError unless the template fits its surface at this origin.
 *
 * Only server templates may wrap past the world's east edge: their source continues at x=0.
 */
export const validatePlacement = (
  template: Placement & { readonly indices?: Uint8Array },
  originX = template.originX,
  originY = template.originY,
): void => {
  if (!Number.isSafeInteger(originX) || !Number.isSafeInteger(originY)) {
    throw new RangeError('template origin must be whole canvas pixels')
  }
  if (
    !Number.isSafeInteger(template.width) ||
    !Number.isSafeInteger(template.height) ||
    template.width <= 0 ||
    template.height <= 0 ||
    (template.indices !== undefined && template.indices.length !== template.width * template.height)
  ) {
    throw new RangeError('template dimensions do not match its pixels')
  }
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  if (surface.kind !== 'world') {
    const bounds = templateSurfaceBounds(surface)
    if (
      bounds === null ||
      originX < bounds.minX ||
      originY < bounds.minY ||
      originX + template.width > bounds.maxX ||
      originY + template.height > bounds.maxY
    ) {
      throw new RangeError(`template is outside the ${surface.kind} canvas`)
    }
    return
  }
  if (originX < 0 || originY < 0) throw new RangeError('template origin is outside the canvas')
  if (originX + template.width > WORLD_PIXELS) {
    if (
      template.wrapX !== true ||
      typeof template.serverUrl !== 'string' ||
      template.width >= WORLD_PIXELS ||
      originX + template.width > WORLD_PIXELS * 2
    ) {
      throw new RangeError('template runs past the east edge')
    }
  }
  if (originY + template.height > WORLD_PIXELS)
    throw new RangeError('template runs past the south edge')
}

export interface HorizontalPlacement {
  readonly originX: number
  readonly width: number
  readonly wrapX?: boolean
}

export interface HorizontalSpan {
  readonly worldStart: number
  readonly worldEnd: number
  readonly sourceStart: number
  readonly sourceEnd: number
}

/** Contiguous world runs for a source whose last columns may wrap through the antimeridian. */
export const horizontalSpans = (template: HorizontalPlacement): readonly HorizontalSpan[] => {
  if (template.wrapX !== true || template.originX + template.width <= WORLD_PIXELS) {
    return [
      {
        worldStart: template.originX,
        worldEnd: template.originX + template.width,
        sourceStart: 0,
        sourceEnd: template.width,
      },
    ]
  }
  const eastWidth = WORLD_PIXELS - template.originX
  return [
    {
      worldStart: template.originX,
      worldEnd: WORLD_PIXELS,
      sourceStart: 0,
      sourceEnd: eastWidth,
    },
    {
      worldStart: 0,
      worldEnd: template.width - eastWidth,
      sourceStart: eastWidth,
      sourceEnd: template.width,
    },
  ]
}

export const horizontalSpanAt = (
  template: HorizontalPlacement,
  worldX: number,
): HorizontalSpan | null =>
  horizontalSpans(template).find((span) => worldX >= span.worldStart && worldX < span.worldEnd) ??
  null

/** Source column at a world x coordinate, or null when the template does not cover it. */
export const sourceXAt = (template: HorizontalPlacement, worldX: number): number | null => {
  const span = horizontalSpanAt(template, worldX)
  return span === null ? null : span.sourceStart + worldX - span.worldStart
}

export const horizontalCentre = (template: HorizontalPlacement): number =>
  template.wrapX === true
    ? (template.originX + template.width / 2) % WORLD_PIXELS
    : template.originX + template.width / 2

/** Shortest signed distance on the wrapping x axis. */
export const wrappedDeltaX = (from: number, to: number): number => {
  const direct = to - from
  if (Math.abs(direct) <= WORLD_PIXELS / 2) return direct
  return direct > 0 ? direct - WORLD_PIXELS : direct + WORLD_PIXELS
}
