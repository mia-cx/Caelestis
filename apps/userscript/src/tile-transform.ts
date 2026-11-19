import { installCanvasWriteTaps } from './canvas-taps.js'
import { registerDebugEntry } from './console-api.js'
import { draftPixelMemoryBytes } from './draft-pixels.js'
import { installMapContextObserver } from './gl-observer.js'
import type { InstalledValueHook } from './page-hooks.js'
import { installPageRequestObserver } from './page-requests.js'
import { pageWindow } from './page-world.js'
import { observePaintRequests } from './paint-requests.js'
import { registerProfileMemorySource } from './profile.js'
import { paletteRgbIndexMemoryBytes } from './rgb-index.js'
import { installBitmapTap, installBlobTap, observeTileResponses } from './tile-attribution.js'
import {
  captureDecodedTile,
  observeTileRequests,
  reloadTiles,
  tilePixelMemoryBytes,
  wantsTileDigest,
} from './tile-pixels.js'

/**
 * Install every page tap that turns Wplace's tiles into frames and pixels: its requests, the bodies
 * and bitmaps they become, its draft canvases, and the map's WebGL context.
 *
 * All of it must be in place before Wplace's modules evaluate and MapLibre calls `getContext`, so it
 * runs at `document-start`. The taps depend on one another, so it is all or nothing: if one cannot
 * be installed, those already installed come off again.
 */
export const install = (realm: Window & typeof globalThis = pageWindow()): void => {
  registerProfileMemorySource('Captured tile pixels', capturedPixelMemoryBytes)
  /** The panel's Reload tiles: visible tiles through the map, kept tiles off screen re-read. */
  registerDebugEntry('reloadTiles', () => reloadTiles())
  observeTileRequests(realm)
  observeTileResponses()
  observePaintRequests()
  const hooks: InstalledValueHook[] = []
  const installers: (() => InstalledValueHook | null)[] = [
    () => installPageRequestObserver(realm),
    () => installBlobTap(realm, wantsTileDigest),
    () => installBitmapTap(realm, captureDecodedTile),
    () => installCanvasWriteTaps(realm),
    () => installMapContextObserver(realm),
  ]
  for (const installer of installers) {
    let installed: InstalledValueHook | null = null
    try {
      installed = installer()
    } catch {
      // A throwing installer refuses like one that returns null.
    }
    if (installed === null) {
      for (const hook of hooks.reverse()) hook.restore()
      return
    }
    hooks.push(installed)
  }
}

/** What captured tile and draft pixels hold in memory, for the profile. */
export const capturedPixelMemoryBytes = (): number =>
  tilePixelMemoryBytes() + draftPixelMemoryBytes() + paletteRgbIndexMemoryBytes()
