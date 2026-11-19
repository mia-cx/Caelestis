import type { SimulatedInput } from '@caelestis/shared'
import { getState } from './settings.js'

/**
 * Whether a simulated-input feature may run.
 *
 * Wplace flags simulated input only in its world paint panel. Its alliance canvases (HQ, avatar,
 * banner) check no input at all, so a feature acting only on one of them always runs, and its
 * Dangerous settings switch governs the world map alone. `onAlliance` must mean that every event
 * the feature dispatches stays inside the alliance canvas: anything sent to `document` or `window`
 * still reaches the world panel's listeners while that panel is mounted.
 */
export const simulatedInputAllowed = (id: SimulatedInput, onAlliance: boolean): boolean =>
  onAlliance || getState().simulatedInput[id] === true

/** Whether Wplace's world paint panel, and with it the listeners that flag input, is mounted. */
export const worldPaintMounted = (): boolean => document.querySelector('[id^="color-"]') !== null
