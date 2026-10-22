import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { type PlacedTemplate, peekTemplatePixels, type TemplateArtwork } from './local-store.js'

/** Longest edge of a preview thumbnail. A tree card shows art at most 8rem tall. */
const THUMBNAIL_EDGE = 128

/** Palette indices for a preview, small enough to keep for every template. */
export interface TemplateThumbnail {
  readonly width: number
  readonly height: number
  readonly indices: Uint8Array
}

/** Kept per artwork, so a preview survives its template's eviction. */
const thumbnails = new WeakMap<TemplateArtwork, TemplateThumbnail>()

const thumbnailOf = (
  artwork: TemplateArtwork,
  width: number,
  height: number,
  indices: Uint8Array,
) => {
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height))
  const thumbnailWidth = Math.max(1, Math.round(width * scale))
  const thumbnailHeight = Math.max(1, Math.round(height * scale))
  let thumbnail: TemplateThumbnail = { width, height, indices }
  if (scale < 1) {
    const sampled = new Uint8Array(thumbnailWidth * thumbnailHeight)
    for (let y = 0; y < thumbnailHeight; y++) {
      const row = Math.floor((y * height) / thumbnailHeight) * width
      for (let x = 0; x < thumbnailWidth; x++) {
        sampled[y * thumbnailWidth + x] =
          indices[row + Math.floor((x * width) / thumbnailWidth)] ?? TRANSPARENT_INDEX
      }
    }
    thumbnail = { width: thumbnailWidth, height: thumbnailHeight, indices: sampled }
  }
  thumbnails.set(artwork, thumbnail)
  return thumbnail
}

/** A template's thumbnail, if its pixels are or have been in memory. */
export const templateThumbnail = (template: PlacedTemplate): TemplateThumbnail | undefined => {
  const cached = thumbnails.get(template.artwork)
  if (cached !== undefined) return cached
  const indices = template.artwork.indices
  return indices === null
    ? undefined
    : thumbnailOf(template.artwork, template.width, template.height, indices)
}

/** A thumbnail for a preview scrolled into view, reading evicted pixels without evicting others. */
export const loadTemplateThumbnail = async (
  template: PlacedTemplate,
): Promise<TemplateThumbnail | undefined> => {
  const cached = templateThumbnail(template)
  if (cached !== undefined) return cached
  const indices = await peekTemplatePixels(template)
  return indices === null
    ? undefined
    : thumbnailOf(template.artwork, template.width, template.height, indices)
}
