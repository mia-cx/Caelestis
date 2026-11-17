import { SIMULATED_INPUT_FLAGS, type SimulatedInput } from '@caelestis/shared'

/** The sentence naming the Wplace flags a simulated-input feature trips. */
export const simulatedInputFlags = (id: SimulatedInput): string => {
  const flags: readonly string[] = SIMULATED_INPUT_FLAGS[id]
  const listed =
    flags.length === 1 ? flags[0] : `${flags.slice(0, -1).join(', ')} and ${flags.at(-1)}`
  return `Trips ${listed}.`
}

/** Every feature that simulates input, in the order the Simulated input settings list them. */
export const SIMULATED_INPUT: readonly {
  readonly id: SimulatedInput
  readonly label: string
  readonly hint: string
  /** The feature this one extends, which must be on for it to apply. */
  readonly extends?: SimulatedInput
}[] = [
  {
    id: 'picker-reads-templates',
    label: 'Picker reads templates',
    hint: "Wplace's picker picks the template colour, then the placed one, by clicking the palette.",
  },
  {
    id: 'middle-click-pick',
    label: 'Middle-click picks template colours',
    hint: 'Middle-click on the map picks the template colour by clicking the palette.',
  },
  {
    id: 'drag-pick',
    label: 'Keep picking while dragging',
    hint: 'Holding the middle button picks each template colour it passes, so Space paints the template as you drag.',
    extends: 'middle-click-pick',
  },
  {
    id: 'shift-paint',
    label: 'Paint past skipped pixels',
    hint: 'Shift+Space keeps painting beyond pixels it skips by simulating Space presses and moves.',
  },
  {
    id: 'cycle-colour',
    label: 'Cycle unfinished colours',
    hint: 'The previous and next colour keys select a colour by clicking the palette.',
  },
  {
    id: 'paint-commit',
    label: 'Paint key commits drafts',
    hint: "The paint draft key commits an open draft by clicking Wplace's Paint button.",
  },
]
