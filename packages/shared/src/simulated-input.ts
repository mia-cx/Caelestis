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
export type HintPart = string | { readonly key: ShortcutId } | { readonly fixed: string }

/** What a shortcut loses while the feature's switch is off. */
type ShortcutPart =
  /** The action does nothing at all. */
  | { readonly inert: true }
  /** Only this part stops: "Committing". */
  | { readonly part: string }

/** Generic over its own ids so the table below can name them before they exist. */
export interface SimulatedInputDefinition<Id extends string = SimulatedInput> {
  readonly label: string
  /** What the feature does, naming the keys it rides on. */
  readonly hint: readonly HintPart[]
  readonly flags: readonly WplaceInputFlag[]
  /** The feature this one extends, which must be on for it to apply. */
  readonly extends?: Id
  /** Shortcuts that simulate input through this feature, and what each loses while it is off. */
  readonly shortcuts?: Readonly<Partial<Record<ShortcutId, ShortcutPart>>>
  /**
   * It dispatches to `document`, where the world paint panel's listeners also hear it while that
   * panel is mounted, even under an alliance editor.
   */
  readonly dispatchesToDocument?: true
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
    dispatchesToDocument: true,
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
    shortcuts: { 'cycle-colour-previous': { inert: true }, 'cycle-colour-next': { inert: true } },
  },
  'paint-commit': {
    label: 'Paint key commits drafts',
    hint: [
      { key: 'paint-action' },
      ' and ',
      { key: 'shade-swap' },
      " commit an open paint draft or shade swap by clicking Wplace's Paint or Swap shade button.",
    ],
    flags: ['UntrustedPaintSubmit'],
    shortcuts: { 'paint-action': { part: 'Committing' }, 'shade-swap': { part: 'Committing' } },
  },
  'capture-paint': {
    label: 'Paint at my capture slot',
    hint: [
      "In a capture run, Caelestis clicks Wplace's Paint button at your slot, to the millisecond.",
    ],
    flags: ['UntrustedPaintSubmit'],
  },
} as const satisfies Record<string, SimulatedInputDefinition<string>>

export type SimulatedInput = keyof typeof SIMULATED_INPUT_TABLE

export const SIMULATED_INPUT: Readonly<Record<SimulatedInput, SimulatedInputDefinition>> =
  SIMULATED_INPUT_TABLE

export const SIMULATED_INPUT_IDS = Object.keys(SIMULATED_INPUT) as readonly SimulatedInput[]

/** Where the settings keep these switches, as the help and settings name it. */
export const DANGEROUS_SETTINGS = 'Settings › Dangerous settings'

/** The features switched on. An absent feature is off. */
export type SimulatedInputSwitches = Readonly<Partial<Record<SimulatedInput, true>>>

const isSimulatedInput = (value: unknown): value is SimulatedInput =>
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

/** The switch behind a shortcut's simulated part, and what the shortcut loses while it is off. */
export type SimulatedShortcutPart = ShortcutPart & { readonly id: SimulatedInput }

/** The feature a shortcut simulates input through, if any. */
export const simulatedPartOf = (shortcut: ShortcutId): SimulatedShortcutPart | undefined => {
  for (const id of SIMULATED_INPUT_IDS) {
    const part = SIMULATED_INPUT[id].shortcuts?.[shortcut]
    if (part !== undefined) return { id, ...part }
  }
  return undefined
}

/** A switch applies only while the feature it extends is on as well. */
export const simulatedInputOn = (switches: SimulatedInputSwitches, id: SimulatedInput): boolean => {
  const parent = SIMULATED_INPUT[id].extends
  return switches[id] === true && (parent === undefined || simulatedInputOn(switches, parent))
}
