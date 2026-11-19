import { log, warn } from '../debug.js'
import { type CustomLayer, getMap, type MapLike, onMapAttached } from '../map-handle.js'
import { onTileFrame } from '../tile-frame.js'
import { CROSSHAIR_LAYER, isDraftLayer, PIXEL_ART_LAYER } from '../wplace-raster.js'

/** Our MapLibre layers' ids, by role. */
export const LAYER_IDS = {
  outline: 'caelestis-outline',
  overlay: 'caelestis-overlay',
  markers: 'caelestis-markers',
  presence: 'caelestis-presence',
  pickCell: 'caelestis-pick-cell',
} as const

type Role = keyof typeof LAYER_IDS

/** Where one of our layers belongs, read off the current draw order. */
interface Placement {
  /** Layers that must draw before this one. */
  readonly after: readonly string[]
  /** Layers that must draw after this one. */
  readonly before: readonly string[]
  /** Insert or move it in front of this layer; undefined is the top, null is "not yet". */
  readonly anchor: string | undefined | null
}

/**
 * The declared order, bottom to top:
 *
 *     outline < pixel-art < overlay < Wplace's drafts < markers < presence < crosshair < pick cell
 *
 * The outline sits under Wplace's art, so painted pixels cover it. The overlay sits under a pixel
 * waiting to be placed, which is what makes placing one look like it covers the template; a marker
 * annotates a pixel, so it cannot sit beneath it. Presence stays under Wplace's crosshair. The pick
 * cell clears one cell to a template colour for Wplace's picker to read, so it draws last of these.
 */
const placements = (order: readonly string[]): Record<Role, Placement> => {
  const present = (id: string): string | undefined => (order.includes(id) ? id : undefined)
  const pixelArt = present(PIXEL_ART_LAYER)
  const crosshair = present(CROSSHAIR_LAYER)
  const crosshairAt = crosshair === undefined ? order.length : order.indexOf(crosshair)
  // Only drafts under the crosshair can be ordered against; one above it is out of our reach.
  const drafts = order.filter((id, index) => isDraftLayer(id) && index < crosshairAt)
  const markersAt = order.indexOf(LAYER_IDS.markers)
  const markersFollowArt =
    markersAt >= 0 && (pixelArt === undefined || markersAt > order.indexOf(pixelArt))
  return {
    outline: {
      after: [],
      before: [PIXEL_ART_LAYER],
      anchor: pixelArt ?? null,
    },
    overlay: {
      after: [PIXEL_ART_LAYER, LAYER_IDS.outline],
      before: [...drafts, LAYER_IDS.markers, CROSSHAIR_LAYER],
      anchor: drafts[0] ?? (markersFollowArt ? LAYER_IDS.markers : crosshair),
    },
    markers: {
      after: [LAYER_IDS.overlay, ...drafts],
      before: [CROSSHAIR_LAYER],
      anchor: crosshair,
    },
    presence: {
      after: [PIXEL_ART_LAYER, LAYER_IDS.markers],
      before: [CROSSHAIR_LAYER],
      anchor: crosshair ?? null,
    },
    pickCell: {
      after: [
        LAYER_IDS.outline,
        LAYER_IDS.overlay,
        LAYER_IDS.markers,
        LAYER_IDS.presence,
        CROSSHAIR_LAYER,
      ],
      before: [],
      anchor: undefined,
    },
  }
}

const inPlace = (order: readonly string[], id: string, placement: Placement): boolean => {
  const at = order.indexOf(id)
  const indices = (ids: readonly string[]) =>
    ids.map((other) => order.indexOf(other)).filter((index) => index >= 0)
  return (
    indices(placement.after).every((index) => index < at) &&
    indices(placement.before).every((index) => index > at)
  )
}

let stack: Record<Role, CustomLayer> | null = null

/**
 * Add whichever of our layers the map lacks, and move any that are out of order.
 *
 * A Wplace theme change swaps the basemap style. MapLibre keeps custom layers across that diff but
 * keeps their numeric position too, and the basemaps differ in length, so a layer can land below
 * `pixel-art-layer`: it still renders, but before the tile quads it needs are recorded. Wplace also
 * adds a draft layer per tile being painted, above ours. Being present is therefore not enough.
 *
 * Each layer is reconciled on its own, bottom first, so one failure leaves the others in place.
 */
const reconcile = (map: MapLike): void => {
  if (stack === null) return
  for (const role of Object.keys(LAYER_IDS) as Role[]) {
    const layer = stack[role]
    try {
      const order = map.style?._order ?? []
      const placement = placements(order)[role]
      if (map.getLayer(layer.id) === undefined) {
        if (placement.anchor === null) continue
        map.addLayer(layer, placement.anchor)
        log(
          'install',
          `${layer.id} inserted ${placement.anchor === undefined ? 'on top' : `before ${placement.anchor}`}`,
        )
        continue
      }
      if (placement.anchor === null || inPlace(order, layer.id, placement)) continue
      map.moveLayer(layer.id, placement.anchor)
      log('install', `${layer.id} moved back into place`)
    } catch (error) {
      warn('install', `could not place ${layer.id}`, String(error))
    }
  }
}

/**
 * Keep our layers in Wplace's map: added once its style loads, and checked on every frame that
 * carries tiles. The check reads the draw order and moves nothing while it is right.
 *
 * Not on `styledata`: moving a layer fires it, and Wplace answers it by moving its own layers, so the
 * two would take turns for as long as the tab lasts.
 */
export const installLayerStack = (layers: Record<Role, CustomLayer>): void => {
  stack = layers
  onMapAttached(reconcile)
  onTileFrame(() => {
    const map = getMap()
    if (map !== null) reconcile(map)
  })
}
