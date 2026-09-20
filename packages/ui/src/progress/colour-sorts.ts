import type { ColourProgressSort } from '../types.js'

/** The orderings the colour progress list offers, in menu order, for any host that renders the picker. */
export const COLOUR_PROGRESS_SORTS: ReadonlyArray<{ key: ColourProgressSort; label: string }> = [
  { key: 'index', label: 'palette index' },
  { key: 'progress', label: 'highest %' },
  { key: 'progress-asc', label: 'lowest %' },
  { key: 'remaining', label: 'most left' },
  { key: 'remaining-asc', label: 'least left' },
  { key: 'total', label: 'biggest' },
  { key: 'free', label: 'free first' },
  { key: 'premium', label: 'premium first' },
]
