import type { ShortcutId, SimulatedInput } from '@caelestis/shared'

/**
 * Hint text interleaved with the keys it names: a Caelestis shortcut shows as currently bound, a
 * fixed Wplace key as written.
 */
export type HintPart = string | { readonly key: ShortcutId } | { readonly fixed: string }

/** Every feature that simulates input, in the order Dangerous settings lists them. */
export const SIMULATED_INPUT: readonly {
  readonly id: SimulatedInput
  readonly label: string
  /** What the feature does, naming the keys it rides on. */
  readonly hint: readonly HintPart[]
  /** The feature this one extends, which must be on for it to apply. */
  readonly extends?: SimulatedInput
}[] = [
  {
    id: 'picker-reads-templates',
    label: 'Picker reads templates',
    hint: [
      "Wplace's picker picks the template colour, then the placed one, by clicking the palette.",
    ],
  },
  {
    id: 'middle-click-pick',
    label: 'Middle-click picks template colours',
    hint: ['Middle-click on the map picks the template colour by clicking the palette.'],
  },
  {
    id: 'drag-pick',
    label: 'Keep picking while dragging',
    hint: [
      'Holding the middle button picks each template colour it passes, so ',
      { fixed: 'Space' },
      ' paints the template as you drag.',
    ],
    extends: 'middle-click-pick',
  },
  {
    id: 'cursor-refresh',
    label: 'Update cursor after flying',
    hint: [
      'When a flight (',
      { key: 'fly-to-colour' },
      "), jump or pan ends under a still mouse, Wplace's hover square and ",
      { fixed: 'Space' },
      ' target move to where the mouse points.',
    ],
  },
  {
    id: 'shift-paint',
    label: 'Paint past skipped pixels',
    hint: [
      { fixed: 'Shift+Space' },
      ' keeps painting beyond pixels it skips by simulating Space presses and moves.',
    ],
  },
  {
    id: 'cycle-colour',
    label: 'Cycle unfinished colours',
    hint: [
      { key: 'cycle-colour-previous' },
      ' and ',
      { key: 'cycle-colour-next' },
      ' select the previous and next unfinished colour by clicking the palette.',
    ],
  },
  {
    id: 'paint-commit',
    label: 'Paint key commits drafts',
    hint: [
      { key: 'paint-action' },
      " commits an open paint draft by clicking Wplace's Paint button.",
    ],
  },
]
