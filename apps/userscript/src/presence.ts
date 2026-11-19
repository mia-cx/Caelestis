import { currentSurface } from './alliance-surface.js'
import { onMapFrame, requestMapFrame, screenProjection } from './map-view.js'
import { presenceMaskMemoryBytes } from './presence-claims.js'
import { installPresence, onPresenceChange } from './presence-client.js'
import { presenceLabelMemoryBytes, renderPresenceLabels } from './presence-labels.js'
import { observePresenceFrame } from './presence-local.js'
import { onSceneHoverChange } from './presence-scene.js'
import { registerProfileMemorySource } from './profile.js'

/** Install presence once: where this tab is looking and drafting, and the other painters' tags. */
export const installPresenceFeatures = (): void => {
  registerProfileMemorySource('Presence region masks', presenceMaskMemoryBytes)
  registerProfileMemorySource('Presence component labels', presenceLabelMemoryBytes)
  installPresence()
  // MapLibre coalesces message bursts into one frame, which also refreshes the screen controls.
  onPresenceChange(requestMapFrame)
  onSceneHoverChange(requestMapFrame)
  // The socket is throttled inside, so feeding it every frame costs a rect comparison.
  onMapFrame(observePresenceFrame, 'Presence viewport')
  onMapFrame((frame) => {
    if (currentSurface().kind === 'world') renderPresenceLabels(frame, screenProjection())
  }, 'Presence labels')
}
