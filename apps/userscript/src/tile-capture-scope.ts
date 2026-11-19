import { onMapFrame } from './map-view.js'
import { onStateChange } from './settings.js'
import { onLocalChange } from './templates/catalog.js'
import { pixelAccounting } from './templates/mismatch.js'
import { captureTilePixels } from './tile-pixels.js'
import { isPaintOpen, onPaintSelectionChange } from './wplace-paint.js'
import { watchCaptureScope } from './wplace-tile-refresh.js'

/**
 * Keep tile pixel capture on for exactly the tiles something reads: mismatch accounting, and the
 * paint drawer's pipette fallback.
 *
 * Install it before the first frame, not on it. A tile can only be caught as it is decoded, and the
 * tiles filling the viewport on a page load are decoded during the load — before any layer of ours
 * has drawn. Deciding at draw time meant each of them waited about ten seconds for Wplace to fetch
 * it again.
 */
export const installTilePixelCapture = (): void => {
  // The pipette fallback reads the exact pixel-art tile, so Paint itself is a pixel consumer even
  // when mismatch markers are off. Starting at drawer-open gives visible tiles time to populate
  // before the one-shot picker click; a miss is also chased on demand by `placedIndexAt`.
  const interest = (tile: { readonly x: number; readonly y: number }): boolean =>
    isPaintOpen() || pixelAccounting.wantsTilePixels(tile)
  const captureScope = watchCaptureScope()
  const sync = (): void => {
    // The scope holds a tile exactly when `wantsTilePixels()` would answer yes, and unlike it,
    // costs nothing on a frame where nothing changed.
    const scope = pixelAccounting.captureScopeTiles()
    captureTilePixels(scope.size > 0 || isPaintOpen(), interest)
    // Pixels kept while capture was off may be stale, and tiles are not re-downloaded on a timer
    // to correct them. When capture starts caring about a tile, re-read it.
    captureScope(isPaintOpen(), scope)
  }
  sync()
  onStateChange(sync)
  onLocalChange(sync)
  // Hidden-template progress widens the scope without a frame, and its idle scan can run first.
  pixelAccounting.onCaptureScopeChange(sync)
  onPaintSelectionChange(sync)
  // And on every frame that carries tiles: at start-up nothing is restored yet, so the first call
  // answers "nothing wants this", and the restore that follows does not necessarily announce
  // itself. Asking again per frame costs a comparison.
  onMapFrame(sync, 'Tile pixel capture state')
}
