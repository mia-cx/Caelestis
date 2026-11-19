import type { ShortcutId } from './shortcuts.js'

/**
 * Caelestis features that simulate input on Wplace's controls, and the flags each one trips.
 *
 * Wplace records untrusted input reaching its paint handlers in a tamper bitmask sent with every
 * paint. The flag names are Wplace's own. Every feature here is off until the painter switches it
 * on; the userscript reads the switch, the settings show it with its flags.
 */
export type WplaceInputFlag =
  | 'UntrustedPaintHold'
  | 'UntrustedPointer'
  | 'UntrustedPalette'
  | 'UntrustedPaintSubmit'

/**
 * Hint text interleaved with the keys it names: a Caelestis shortcut shows as currently bound, a
 * fixed Wplace key as written.
 */
export type HintPart<Key extends string = ShortcutId> =
  | string
  | { readonly key: Key }
  | { readonly fixed: string }

/** Generic over the ids it names so the table below can be checked before those ids exist. */
export interface SimulatedInputDefinition<
  Key extends string = ShortcutId,
  Id extends string = SimulatedInput,
> {
  readonly label: string
  /** What the feature does, naming the keys it rides on. */
  readonly hint: readonly HintPart<Key>[]
  readonly flags: readonly WplaceInputFlag[]
  /** The feature this one extends, which must be on for it to apply. */
  readonly extends?: Id
}

/** In the order Dangerous settings lists them. */
const SIMULATED_INPUT_TABLE = {
  'picker-reads-templates': {
    label: 'Picker reads templates',
    hint: [
      "Wplace's picker picks the template colour, then the placed one, by clicking the palette.",
    ],
    flags: ['UntrustedPalette'],
  },
  'middle-click-pick': {
    label: 'Middle-click picks template colours',
    hint: ['Middle-click on the map picks the template colour by clicking the palette.'],
    flags: ['UntrustedPalette'],
  },
  'drag-pick': {
    label: 'Keep picking while dragging',
    hint: [
      'Holding the middle button picks each template colour it passes, so ',
      { fixed: 'Space' },
      ' paints the template as you drag.',
    ],
    flags: ['UntrustedPalette', 'UntrustedPointer'],
    extends: 'middle-click-pick',
  },
  'cursor-refresh': {
    label: 'Update cursor after flying',
    hint: [
      'When a flight (',
      { key: 'fly-to-colour' },
      "), jump or pan ends under a still mouse, Wplace's hover square and ",
      { fixed: 'Space' },
      ' target move to where the mouse points.',
    ],
    flags: ['UntrustedPointer'],
  },
  'shift-paint': {
    label: 'Paint past skipped pixels',
    hint: [
      { fixed: 'Shift+Space' },
      ' keeps painting beyond pixels it skips by simulating Space presses and moves.',
    ],
    flags: ['UntrustedPaintHold', 'UntrustedPointer'],
  },
  'cycle-colour': {
    label: 'Cycle unfinished colours',
    hint: [
      { key: 'cycle-colour-previous' },
      ' and ',
      { key: 'cycle-colour-next' },
      ' select the previous and next unfinished colour by clicking the palette.',
    ],
    flags: ['UntrustedPalette'],
  },
  'paint-commit': {
    label: 'Paint key commits drafts',
    hint: [
      { key: 'paint-action' },
      " commits an open paint draft by clicking Wplace's Paint button.",
    ],
    flags: ['UntrustedPaintSubmit'],
  },
} as const satisfies Record<string, SimulatedInputDefinition<string, string>>

export type SimulatedInput = keyof typeof SIMULATED_INPUT_TABLE

export const SIMULATED_INPUT: Readonly<Record<SimulatedInput, SimulatedInputDefinition>> =
  SIMULATED_INPUT_TABLE

export const SIMULATED_INPUT_IDS = Object.keys(SIMULATED_INPUT) as readonly SimulatedInput[]

/** Where the settings keep these switches, as the help and settings name it. */
export const DANGEROUS_SETTINGS = 'Settings › Dangerous settings'

/** The features switched on. An absent feature is off. */
export type SimulatedInputSwitches = Readonly<Partial<Record<SimulatedInput, true>>>

export const isSimulatedInput = (value: unknown): value is SimulatedInput =>
  typeof value === 'string' && Object.hasOwn(SIMULATED_INPUT, value)

/** Keep only known features switched on, so stored junk never turns anything on. */
export const normaliseSimulatedInput = (value: unknown): SimulatedInputSwitches => {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([id, on]) => isSimulatedInput(id) && on === true)
      .map(([id]) => [id, true]),
  )
}

/** A switch applies only while the feature it extends is on as well. */
export const simulatedInputOn = (switches: SimulatedInputSwitches, id: SimulatedInput): boolean => {
  const parent = SIMULATED_INPUT[id].extends
  return switches[id] === true && (parent === undefined || simulatedInputOn(switches, parent))
}
