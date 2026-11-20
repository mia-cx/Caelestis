import type { TileCoord } from '@caelestis/shared'

/**
 * One template's part of one Wplace tile: the key every per-tile accounting collection uses.
 *
 * Spelled `${templateId}|${x}/${y}`. Only the tile half has a known shape, and a server template's
 * id is `srv:<encoded-url>:<id>`, so the last `|` is the split, never the first.
 */
export type TemplateTileKey = string

export const templateTileKey = (templateId: string, tile: TileCoord): TemplateTileKey =>
  `${templateId}|${tile.x}/${tile.y}`

/** The suffix every key for this tile ends with, whatever its template. */
export const tileSuffix = (tile: TileCoord): string => `|${tile.x}/${tile.y}`

/** The prefix every key for this template starts with, whatever its tile. */
export const templatePrefix = (templateId: string): string => `${templateId}|`

export const templateIdOf = (key: TemplateTileKey): string => key.slice(0, key.lastIndexOf('|'))

export const tileOf = (key: TemplateTileKey): TileCoord | null => {
  const templateId = templateIdOf(key)
  const separator = key.indexOf('/', templateId.length + 1)
  if (separator < 0) return null
  const x = Number(key.slice(templateId.length + 1, separator))
  const y = Number(key.slice(separator + 1))
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}
