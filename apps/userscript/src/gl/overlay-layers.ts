import { redraw, requestMapFrame } from '../map-view.js'
import { onStateChange } from '../settings.js'
import { onLocalChange, onLocalPreviewChange } from '../templates/catalog.js'
import { pixelAccounting } from '../templates/mismatch.js'
import { onMapThemeChange } from './contrast-outline.js'
import { installOverlayDiagnostics, outlineLayer, overlayLayer } from './layer.js'
import { installLayerStack } from './layer-stack.js'
import { installMarkerLayer, markerLayer } from './markers.js'
import { pickCellLayer } from './pick-cell-layer.js'
import { presenceLayer } from './presence-layer.js'

/** Keep our GL layers on whichever map Wplace shows, and repaint whenever what they draw changes. */
export const installOverlayLayers = (): void => {
  installOverlayDiagnostics()
  installMarkerLayer()
  installLayerStack({
    outline: outlineLayer,
    overlay: overlayLayer,
    markers: markerLayer,
    presence: presenceLayer,
    pickCell: pickCellLayer,
  })
  // A completed scan changes marker buffers and progress only. Progress has its own DOM listeners;
  // rerunning every screen-space overlay control here duplicates the MapLibre frame requested next.
  pixelAccounting.onChange(requestMapFrame)
  onLocalChange(redraw)
  onLocalPreviewChange(redraw)
  onStateChange(redraw)
  onMapThemeChange(redraw)
}
