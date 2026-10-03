import type { CaelestisRailControl, RailControlIntent } from '@caelestis/ui/elements'
import { activeAllianceSurface } from '../alliance-surface.js'
import { claimModePurpose, stopClaimMode } from '../claim-editor.js'
import { redraw } from '../main.js'
import { presenceView } from '../presence-client.js'
import { shortcutHint } from '../shortcut-bindings.js'
import { getState, onStateChange, setState } from '../state.js'
import { openCaptureTool, openClaimTool } from './presence-actions.js'
import { applyWplaceTheme } from './theme.js'

export const MISMATCH_MODE_ID = 'caelestis-mismatch-mode'
export const CLAIM_TOOL_ID = 'caelestis-claim-tool-mode'
export const CAPTURE_TOOL_ID = 'caelestis-capture-tool-mode'
export const PRESENCE_MODE_ID = 'caelestis-presence-mode'

/**
 * Keep the rail's stateful buttons current with persisted state: their pressed states and the key
 * hints read from stored bindings. Called once at install; the button factories are also the
 * recovery path after Wplace drops a control, so they must not subscribe themselves.
 */
export const installRailStateSync = (): void => {
  onStateChange(syncMismatchModeState)
  onStateChange(syncPresenceModeState)
  onStateChange(syncClaimToolState)
  onStateChange(syncCaptureToolState)
}

export const syncPresenceModeState = (): void => {
  const button = document.getElementById(PRESENCE_MODE_ID) as CaelestisRailControl | null
  if (button === null) return
  const on = getState().showPresence
  button.model = {
    id: 'presence',
    label: `${on ? 'Hide' : 'Show'} other painters and claims${shortcutHint('toggle-presence')}`,
    pressed: on,
  }
}

/** The always-reachable switch for other painters, so it works where there is no keyboard. */
export const presenceModeButton = (): CaelestisRailControl => {
  const existing = document.getElementById(PRESENCE_MODE_ID)
  if (existing !== null) return existing as CaelestisRailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = PRESENCE_MODE_ID
  applyWplaceTheme(button)
  button.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id !== 'presence') return
    setState({ showPresence: !getState().showPresence })
    syncPresenceModeState()
    redraw()
  })
  syncPresenceModeState()
  return button
}

export const syncClaimToolState = (): void => {
  const button = document.getElementById(CLAIM_TOOL_ID) as CaelestisRailControl | null
  if (button === null) return
  const active = claimModePurpose() === 'claim'
  const view = presenceView()
  // Alliance artboards have no presence room, so claims only exist on the world canvas.
  const ready = view.connected && view.me !== null && activeAllianceSurface() === null
  button.model = {
    id: 'claim',
    label: active ? 'Leave claim mode (Esc)' : `Claim a region${shortcutHint('claim-mode')}`,
    title:
      ready || active
        ? active
          ? 'Leave claim mode without saving (Esc)'
          : `Claim a region: draw shapes, paths, and strokes over the map${shortcutHint('claim-mode')}`
        : 'Claim a region. Needs a connected server with painter presence and a Wplace sign-in.',
    pressed: active,
    ...(ready || active ? {} : { disabled: true }),
  }
}

/** The always-reachable way into the region claim tool, beside the panel and marker switches. */
export const claimToolButton = (): CaelestisRailControl => {
  const existing = document.getElementById(CLAIM_TOOL_ID)
  if (existing !== null) return existing as CaelestisRailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = CLAIM_TOOL_ID
  applyWplaceTheme(button)
  button.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id !== 'claim') return
    if (claimModePurpose() === 'claim') stopClaimMode()
    else {
      stopClaimMode()
      // The rail control only looks disabled; the guard is here.
      const view = presenceView()
      if (!(view.connected && view.me !== null && activeAllianceSurface() === null)) return
      openClaimTool()
    }
    syncClaimToolState()
    syncCaptureToolState()
  })
  syncClaimToolState()
  return button
}

export const syncCaptureToolState = (): void => {
  const button = document.getElementById(CAPTURE_TOOL_ID) as CaelestisRailControl | null
  if (button === null) return
  const active = claimModePurpose() === 'capture'
  // Alliance artboards have no world tiles to capture from.
  const ready = activeAllianceSurface() === null
  button.model = {
    id: 'capture',
    label: active ? 'Leave capture mode (Esc)' : 'Capture a region as a template',
    title: active
      ? 'Leave capture mode without capturing (Esc)'
      : ready
        ? 'Capture a region: select map art to download as a PNG or move as a new template'
        : 'Capture a region. Only available on the world map.',
    pressed: active,
    ...(ready || active ? {} : { disabled: true }),
  }
}

/** The way into capture mode, which selects map art to download or open as a template. */
export const captureToolButton = (): CaelestisRailControl => {
  const existing = document.getElementById(CAPTURE_TOOL_ID)
  if (existing !== null) return existing as CaelestisRailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = CAPTURE_TOOL_ID
  applyWplaceTheme(button)
  button.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id !== 'capture') return
    if (claimModePurpose() === 'capture') stopClaimMode()
    else {
      if (activeAllianceSurface() !== null) return
      stopClaimMode()
      openCaptureTool()
    }
    syncClaimToolState()
    syncCaptureToolState()
  })
  syncCaptureToolState()
  return button
}

export const syncMismatchModeState = (): void => {
  const button = document.getElementById(MISMATCH_MODE_ID) as CaelestisRailControl | null
  if (button === null) return
  const on = getState().appearance.markMismatch
  const label = on ? 'Hide global mismatch markers' : 'Show global mismatch markers'
  button.model = { id: 'mismatch', label: `${label}${shortcutHint('toggle-markers')}`, pressed: on }
}

/** The always-reachable switch for the global marker default. */
export const mismatchModeButton = (): CaelestisRailControl => {
  const existing = document.getElementById(MISMATCH_MODE_ID)
  if (existing !== null) return existing as CaelestisRailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = MISMATCH_MODE_ID
  applyWplaceTheme(button)
  button.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id !== 'mismatch') return
    const appearance = getState().appearance
    setState({ appearance: { ...appearance, markMismatch: !appearance.markMismatch } })
    syncMismatchModeState()
    redraw()
  })
  syncMismatchModeState()
  return button
}
