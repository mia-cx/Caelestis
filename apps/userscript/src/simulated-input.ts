import { type SimulatedInput, simulatedInputOn } from '@caelestis/shared'
import { activeAllianceEditorStage } from './alliance-surface.js'
import { getState } from './settings.js'
import { worldPaintMounted } from './wplace-dom.js'

/**
 * Features that dispatch to `document`, where the world paint panel's listeners also hear them
 * while that panel is mounted, even under an alliance editor.
 */
const DISPATCHES_TO_DOCUMENT: ReadonlySet<SimulatedInput> = new Set(['shift-paint'])

/**
 * Whether Caelestis is acting on an alliance canvas. The one place that decides it: an open
 * alliance editor counts even before its surface resolves, since its controls are already there.
 */
const onAllianceCanvas = (): boolean => activeAllianceEditorStage() !== null

/**
 * Whether a simulated-input feature may run.
 *
 * Wplace flags simulated input only in its world paint panel. Its alliance canvases (HQ, avatar,
 * banner) check no input at all, so there a feature always runs, unless what it dispatches still
 * reaches the world panel's listeners. Elsewhere its Dangerous settings switch decides.
 */
export const simulatedInputAllowed = (id: SimulatedInput): boolean =>
  simulatedInputOn(getState().simulatedInput, id) ||
  (onAllianceCanvas() && !(DISPATCHES_TO_DOCUMENT.has(id) && worldPaintMounted()))
