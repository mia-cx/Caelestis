import type { ShortcutId } from '@caelestis/shared'

export type ShortcutCategory = 'Painting' | 'Overlay'

export interface ShortcutAction {
  readonly id: ShortcutId
  readonly category: ShortcutCategory
  /** How the action is named wherever its key is shown: the reference and the settings. */
  readonly label: string
  /** What of the action waits for the Simulated clicks switch, shown wherever it is off. */
  readonly simulatedClicksNote?: string
}

/** The settings switch that lets shortcuts click Wplace's palette and Paint button. */
export const SIMULATED_CLICKS_LABEL = 'Simulated clicks'

const NEEDS_SIMULATED_CLICKS = `Needs ${SIMULATED_CLICKS_LABEL}`

/** Every rebindable action in the order the reference and the settings list them. */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  {
    id: 'cycle-colour-previous',
    category: 'Painting',
    label: 'Previous unfinished colour',
    simulatedClicksNote: NEEDS_SIMULATED_CLICKS,
  },
  {
    id: 'cycle-colour-next',
    category: 'Painting',
    label: 'Next unfinished colour',
    simulatedClicksNote: NEEDS_SIMULATED_CLICKS,
  },
  {
    id: 'paint-action',
    category: 'Painting',
    label: 'Open or commit paint draft',
    simulatedClicksNote: `Committing needs ${SIMULATED_CLICKS_LABEL}`,
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

/** The note an action carries while Simulated clicks is off, if part of it needs the switch. */
export const simulatedClicksNote = (
  id: ShortcutId,
  simulatedClicks: boolean,
): string | undefined =>
  simulatedClicks
    ? undefined
    : SHORTCUT_ACTIONS.find((action) => action.id === id)?.simulatedClicksNote
