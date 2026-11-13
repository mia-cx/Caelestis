/**
 * Caelestis features that simulate input on Wplace's controls, and the flags each one trips.
 *
 * Wplace records untrusted input reaching its paint handlers in a tamper bitmask sent with every
 * paint. The names are Wplace's own. Every feature here is off until the painter switches it on;
 * the userscript reads the switch, the settings show it with its flags.
 */
export const SIMULATED_INPUT_FLAGS = {
  /** Answer Wplace's picker tool from template and placed pixels by clicking a swatch. */
  'picker-reads-templates': ['UntrustedPalette'],
  /** Middle-click on the map picks the template colour by clicking a swatch. */
  'middle-click-pick': ['UntrustedPalette'],
  /** Holding the middle button keeps picking, forwarding moves so painting follows. */
  'drag-pick': ['UntrustedPalette', 'UntrustedPointer'],
  /** Shift+Space lifts the brush over skipped pixels with simulated Space presses and moves. */
  'shift-paint': ['UntrustedPaintHold', 'UntrustedPointer'],
  /** The previous-colour shortcut clicks a swatch. */
  'cycle-colour-previous': ['UntrustedPalette'],
  /** The next-colour shortcut clicks a swatch. */
  'cycle-colour-next': ['UntrustedPalette'],
  /** The paint key commits an open draft by clicking the drawer's Paint button. */
  'paint-commit': ['UntrustedPaintSubmit'],
} as const satisfies Record<string, readonly WplaceInputFlag[]>

export type WplaceInputFlag =
  | 'UntrustedPaintHold'
  | 'UntrustedPointer'
  | 'UntrustedPalette'
  | 'UntrustedPaintSubmit'

export type SimulatedInput = keyof typeof SIMULATED_INPUT_FLAGS

/** The features switched on. An absent feature is off. */
export type SimulatedInputSwitches = Readonly<Partial<Record<SimulatedInput, true>>>

export const isSimulatedInput = (value: unknown): value is SimulatedInput =>
  typeof value === 'string' && Object.hasOwn(SIMULATED_INPUT_FLAGS, value)

/** Keep only known features switched on, so stored junk never turns anything on. */
export const normaliseSimulatedInput = (value: unknown): SimulatedInputSwitches => {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([id, on]) => isSimulatedInput(id) && on === true)
      .map(([id]) => [id, true]),
  )
}
