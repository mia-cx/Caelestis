import type { CaelestisElement } from '@caelestis/ui/elements'
import { activeAllianceSurface } from '../alliance-surface.js'
import { isCaptureModeActive, isClaimModeActive, stopClaimMode } from '../claim-editor.js'
import { redraw } from '../main.js'
import { presenceView } from '../presence-client.js'
import { shortcutHint } from '../shortcut-bindings.js'
import { getState, onStateChange, setState } from '../state.js'
import { openClaimTool } from './presence-actions.js'
import { applyWplaceTheme } from './theme.js'

export const MISMATCH_MODE_ID = 'caelestis-mismatch-mode'
export const CLAIM_TOOL_ID = 'caelestis-claim-tool-mode'
export const PRESENCE_MODE_ID = 'caelestis-presence-mode'

type RailControl = CaelestisElement<'caelestis-rail-control'>

/**
 * Keep the rail's stateful buttons current with persisted state: their pressed states and the key
 * hints read from stored bindings. Called once at install; the button factories are also the
 * recovery path after Wplace drops a control, so they must not subscribe themselves.
 */
export const installRailStateSync = (): void => {
  onStateChange(syncMismatchModeState)
  onStateChange(syncPresenceModeState)
  onStateChange(syncClaimToolState)
}

export const syncPresenceModeState = (): void => {
  const button = document.getElementById(PRESENCE_MODE_ID) as RailControl | null
  if (button === null) return
  const on = getState().showPresence
  button.model = {
    icon: 'painters',
    label: `${on ? 'Hide' : 'Show'} other painters and claims${shortcutHint('toggle-presence')}`,
    pressed: on,
  }
}

/** The always-reachable switch for other painters, so it works where there is no keyboard. */
export const presenceModeButton = (): RailControl => {
  const existing = document.getElementById(PRESENCE_MODE_ID)
  if (existing !== null) return existing as RailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = PRESENCE_MODE_ID
  applyWplaceTheme(button)
  button.addEventListener('click', () => {
    setState({ showPresence: !getState().showPresence })
    syncPresenceModeState()
    redraw()
  })
  syncPresenceModeState()
  return button
}

export const syncClaimToolState = (): void => {
  const button = document.getElementById(CLAIM_TOOL_ID) as RailControl | null
  if (button === null) return
  const active = isClaimModeActive()
  const capturing = isCaptureModeActive()
  const view = presenceView()
  // Alliance artboards have no presence room, so claims only exist on the world canvas.
  const ready = view.connected && view.me !== null && activeAllianceSurface() === null
  button.model = {
    icon: 'shapes',
    label: capturing
      ? 'Leave capture mode (Esc)'
      : active
        ? 'Leave claim mode (Esc)'
        : `Claim a region${shortcutHint('claim-mode')}`,
    title:
      ready || active
        ? capturing
          ? 'Leave capture mode without capturing (Esc)'
          : active
            ? 'Leave claim mode without saving (Esc)'
            : `Claim a region: draw shapes, paths, and strokes over the map${shortcutHint('claim-mode')}`
        : 'Claim a region. Needs a connected server with painter presence and a Wplace sign-in.',
    pressed: active,
    ...(ready || active ? {} : { disabled: true }),
  }
}

/** The always-reachable way into the region claim tool, beside the panel and marker switches. */
export const claimToolButton = (): RailControl => {
  const existing = document.getElementById(CLAIM_TOOL_ID)
  if (existing !== null) return existing as RailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = CLAIM_TOOL_ID
  applyWplaceTheme(button)
  button.addEventListener('click', () => {
    if (isClaimModeActive()) stopClaimMode()
    else {
      // The rail control only looks disabled; the guard is here.
      const view = presenceView()
      if (!(view.connected && view.me !== null && activeAllianceSurface() === null)) return
      openClaimTool()
    }
    syncClaimToolState()
  })
  syncClaimToolState()
  return button
}

export const syncMismatchModeState = (): void => {
  const button = document.getElementById(MISMATCH_MODE_ID) as RailControl | null
  if (button === null) return
  const on = getState().appearance.markMismatch
  const label = on ? 'Hide global mismatch markers' : 'Show global mismatch markers'
  button.model = { icon: 'bug', label: `${label}${shortcutHint('toggle-markers')}`, pressed: on }
}

/** The always-reachable switch for the global marker default. */
export const mismatchModeButton = (): RailControl => {
  const existing = document.getElementById(MISMATCH_MODE_ID)
  if (existing !== null) return existing as RailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = MISMATCH_MODE_ID
  applyWplaceTheme(button)
  button.addEventListener('click', () => {
    const appearance = getState().appearance
    setState({ appearance: { ...appearance, markMismatch: !appearance.markMismatch } })
    syncMismatchModeState()
    redraw()
  })
  syncMismatchModeState()
  return button
}
