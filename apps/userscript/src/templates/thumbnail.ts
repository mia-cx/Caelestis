import { type PlacedTemplate, peekTemplatePixels, type TemplateArtwork } from './local-store.js'
import { joinPixels, pixelAt, type SparsePixels } from './sparse-pixels.js'

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

const thumbnailOf = (artwork: TemplateArtwork, pixels: SparsePixels) => {
  const { width, height } = pixels
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height))
  const thumbnailWidth = Math.max(1, Math.round(width * scale))
  const thumbnailHeight = Math.max(1, Math.round(height * scale))
  let thumbnail: TemplateThumbnail
  if (scale === 1) thumbnail = { width, height, indices: joinPixels(pixels) }
  else {
    const sampled = new Uint8Array(thumbnailWidth * thumbnailHeight)
    for (let y = 0; y < thumbnailHeight; y++) {
      const sourceY = Math.floor((y * height) / thumbnailHeight)
      for (let x = 0; x < thumbnailWidth; x++) {
        sampled[y * thumbnailWidth + x] = pixelAt(
          pixels,
          Math.floor((x * width) / thumbnailWidth),
          sourceY,
        )
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
  const pixels = template.artwork.pixels
  return pixels === null ? undefined : thumbnailOf(template.artwork, pixels)
}

/** A thumbnail for a preview scrolled into view, reading evicted pixels without evicting others. */
export const loadTemplateThumbnail = async (
  template: PlacedTemplate,
): Promise<TemplateThumbnail | undefined> => {
  const cached = templateThumbnail(template)
  if (cached !== undefined) return cached
  const pixels = await peekTemplatePixels(template)
  return pixels === null ? undefined : thumbnailOf(template.artwork, pixels)
}
