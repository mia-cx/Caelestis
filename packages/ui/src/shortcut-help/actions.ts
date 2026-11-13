import type { ShortcutId, SimulatedInput, SimulatedInputSwitches } from '@caelestis/shared'
import { simulatedInputFlags } from '../simulated-input.js'

export type ShortcutCategory = 'Painting' | 'Overlay'

export interface ShortcutAction {
  readonly id: ShortcutId
  readonly category: ShortcutCategory
  /** How the action is named wherever its key is shown: the reference and the settings. */
  readonly label: string
  /** The part of the action that simulates clicks on Wplace's controls, behind its own switch. */
  readonly simulated?: {
    readonly id: SimulatedInput
    /** What the switch lets the action click. */
    readonly clicks: string
    /** The reference's note while the switch is off. */
    readonly off: string
  }
}

const OFF = 'Off under Settings › Keyboard shortcuts'

/** Every rebindable action in the order the reference and the settings list them. */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  {
    id: 'cycle-colour-previous',
    category: 'Painting',
    label: 'Previous unfinished colour',
    simulated: { id: 'cycle-colour-previous', clicks: "Clicks Wplace's palette.", off: OFF },
  },
  {
    id: 'cycle-colour-next',
    category: 'Painting',
    label: 'Next unfinished colour',
    simulated: { id: 'cycle-colour-next', clicks: "Clicks Wplace's palette.", off: OFF },
  },
  {
    id: 'paint-action',
    category: 'Painting',
    label: 'Open or commit paint draft',
    simulated: {
      id: 'paint-commit',
      clicks: "Committing clicks Wplace's Paint button.",
      off: 'Committing is off under Settings › Keyboard shortcuts',
    },
  },
  { id: 'cancel-paint', category: 'Painting', label: 'Cancel paint draft' },
  { id: 'fly-to-colour', category: 'Painting', label: 'Jump to selected colour' },
  { id: 'peek-overlays', category: 'Painting', label: 'Hold to peek at the map' },
  { id: 'undo-paint', category: 'Painting', label: 'Undo drafted pixels (hold)' },
  { id: 'redo-paint', category: 'Painting', label: 'Redo drafted pixels (hold)' },
  { id: 'toggle-panel', category: 'Overlay', label: 'Caelestis panel' },
  { id: 'toggle-theme', category: 'Overlay', label: 'Light / dark theme' },
  { id: 'claim-mode', category: 'Overlay', label: 'Claim mode' },
  { id: 'toggle-presence', category: 'Overlay', label: 'Other painters and claims' },
  { id: 'toggle-rings', category: 'Overlay', label: 'Toggle contrast rings' },
  { id: 'toggle-colour', category: 'Overlay', label: 'Selected colour only' },
  { id: 'toggle-template-menu', category: 'Overlay', label: 'Template display menu' },
  { id: 'toggle-visibility', category: 'Overlay', label: 'Template visibility' },
  { id: 'toggle-markers', category: 'Overlay', label: 'Mismatch markers' },
  { id: 'toggle-selected-colour-markers', category: 'Overlay', label: 'Selected-colour markers' },
  { id: 'set-opacity-20', category: 'Overlay', label: 'Overlay opacity 20%' },
  { id: 'set-opacity-40', category: 'Overlay', label: 'Overlay opacity 40%' },
  { id: 'set-opacity-60', category: 'Overlay', label: 'Overlay opacity 60%' },
  { id: 'set-opacity-80', category: 'Overlay', label: 'Overlay opacity 80%' },
  { id: 'set-opacity-100', category: 'Overlay', label: 'Overlay opacity 100%' },
  { id: 'show-shortcut-help', category: 'Overlay', label: 'Keyboard shortcuts' },
]

export const shortcutActionLabel = (id: ShortcutId): string =>
  SHORTCUT_ACTIONS.find((action) => action.id === id)?.label ?? id

export const shortcutSimulatedInput = (id: ShortcutId): ShortcutAction['simulated'] =>
  SHORTCUT_ACTIONS.find((action) => action.id === id)?.simulated

/** What an action's switch does and the flags it trips, shown beside the switch. */
export const simulatedShortcutHint = (
  simulated: NonNullable<ShortcutAction['simulated']>,
): string => `${simulated.clicks} ${simulatedInputFlags(simulated.id)}`

/** The reference's note for an action whose simulated part is switched off. */
export const simulatedShortcutNote = (
  id: ShortcutId,
  switches: SimulatedInputSwitches,
): string | undefined => {
  const simulated = shortcutSimulatedInput(id)
  return simulated === undefined || switches[simulated.id] ? undefined : simulated.off
}
