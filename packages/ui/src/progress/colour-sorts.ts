import { WPLACE_PALETTE } from '@caelestis/shared'
import type { ProgressModel } from './model.js'

/** The orderings a colour progress list offers, in menu order, for any host that renders the picker. */
export const COLOUR_PROGRESS_SORTS = [
  { key: 'index', label: 'palette index' },
  { key: 'name', label: 'name' },
  { key: 'progress', label: 'highest %' },
  { key: 'progress-asc', label: 'lowest %' },
  { key: 'remaining', label: 'most left' },
  { key: 'remaining-asc', label: 'least left' },
  { key: 'mismatched', label: 'most mismatched' },
  { key: 'unpainted', label: 'most unpainted' },
  { key: 'total', label: 'biggest' },
  { key: 'free', label: 'free first' },
  { key: 'premium', label: 'premium first' },
] as const

export type ColourProgressSort = (typeof COLOUR_PROGRESS_SORTS)[number]['key']

/** The counts a colour row sorts by, for one palette index. */
export type SortableColour = Pick<
  ProgressModel,
  'completed' | 'mismatched' | 'unpainted' | 'total'
> & {
  readonly index: number
}

const done = (colour: SortableColour): number =>
  colour.total === 0 ? 0 : colour.completed / colour.total
const left = (colour: SortableColour): number => colour.total - colour.completed
const notKind = (colour: SortableColour, kind: 'free' | 'premium'): number =>
  Number(WPLACE_PALETTE[colour.index]?.kind !== kind)

/** Orders colour rows by `sort`; ties fall back to palette order. */
export const compareColours =
  (sort: ColourProgressSort) =>
  (a: SortableColour, b: SortableColour): number => {
    const difference = (() => {
      switch (sort) {
        case 'index':
          return 0
        case 'name':
          return (WPLACE_PALETTE[a.index]?.name ?? '').localeCompare(
            WPLACE_PALETTE[b.index]?.name ?? '',
          )
        case 'progress':
          return done(b) - done(a)
        case 'progress-asc':
          return done(a) - done(b)
        case 'remaining':
          return left(b) - left(a)
        case 'remaining-asc':
          return left(a) - left(b)
        case 'mismatched':
          return b.mismatched - a.mismatched
        case 'unpainted':
          return b.unpainted - a.unpainted
        case 'total':
          return b.total - a.total
        case 'free':
          return notKind(a, 'free') - notKind(b, 'free')
        case 'premium':
          return notKind(a, 'premium') - notKind(b, 'premium')
      }
    })()
    return difference || a.index - b.index
  }
