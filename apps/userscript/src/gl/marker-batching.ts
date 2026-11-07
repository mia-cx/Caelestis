import type { MarkList } from '../templates/mark-list.js'

export interface BatchableMarkerStyle {
  readonly size: number
  readonly thickness: number
  readonly colour: readonly [number, number, number]
  readonly otherColour: readonly [number, number, number] | null
  readonly otherOpacity: number
  readonly selected: number
}

export interface BatchableMarkerWork {
  /** Stable projection identity. Work can merge only when these are the same object. */
  readonly tile: object
  readonly marks: MarkList
  readonly style: BatchableMarkerStyle
  readonly fade: number
}

/** One draw setup for several lists: the representative work's tile, style and fade. */
export type MarkerBatch<Work extends BatchableMarkerWork> = Omit<Work, 'marks'> & {
  readonly marks: readonly MarkList[]
}

const sameColour = (
  left: readonly [number, number, number] | null,
  right: readonly [number, number, number] | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left[0] === right[0] &&
    left[1] === right[1] &&
    left[2] === right[2])

const sameDrawState = (left: BatchableMarkerWork, right: BatchableMarkerWork): boolean =>
  left.fade === right.fade &&
  left.style.size === right.style.size &&
  left.style.thickness === right.style.thickness &&
  sameColour(left.style.colour, right.style.colour) &&
  sameColour(left.style.otherColour, right.style.otherColour) &&
  left.style.otherOpacity === right.style.otherOpacity &&
  left.style.selected === right.style.selected

/** Whether every point in this work necessarily emits the same RGB colour. */
const hasOrderIndependentColour = ({ style }: BatchableMarkerWork): boolean =>
  style.selected < 0 || style.otherColour === null || sameColour(style.colour, style.otherColour)

const single = <Work extends BatchableMarkerWork>(work: Work): MarkerBatch<Work> => ({
  ...work,
  marks: [work.marks],
})

/**
 * Collapse the common case of many templates sharing one marker appearance into one setup per tile.
 *
 * Different appearances retain their exact draw order. Combining them by style would reorder
 * overlapping translucent markers, which changes the result; when every batch has the same draw
 * state, drawing a tile's lists back to back is pixel-for-pixel equivalent and removes dozens of
 * redundant state changes from a dense multi-template viewport. The lists stay separate, so a paint
 * that patches one of them re-uploads only its changed slots.
 */
export const batchMarkerWork = <Work extends BatchableMarkerWork>(
  work: readonly Work[],
): MarkerBatch<Work>[] => {
  const first = work[0]
  if (first === undefined || work.length === 1) return work.map(single)
  if (!work.every((candidate) => sameDrawState(first, candidate))) return work.map(single)
  // Tile grouping changes template-major primitive order. That is blend-equivalent when every
  // point uses one RGB colour, but not while selected-colour dimming can emit two different
  // colours from the same work item at an overlapping tile boundary.
  if (!work.every(hasOrderIndependentColour)) return work.map(single)

  const byTile = new Map<object, { readonly representative: Work; readonly marks: MarkList[] }>()
  for (const candidate of work) {
    const group = byTile.get(candidate.tile)
    if (group === undefined)
      byTile.set(candidate.tile, { representative: candidate, marks: [candidate.marks] })
    else group.marks.push(candidate.marks)
  }
  return [...byTile.values()].map(({ representative, marks }) => ({ ...representative, marks }))
}
