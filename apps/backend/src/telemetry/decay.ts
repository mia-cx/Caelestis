/**
 * What the telemetry and tile-history decay ladders share: an edge folds one tier into the next,
 * and the rule for when a window has folded. `db/schema.ts` renders its resolution CHECKs from the
 * ladders, so a ladder change shows up as a schema diff.
 */
export interface DecayEdge {
  readonly source: number
  readonly target: number
  readonly retainSeconds: number
}

/** Target groups processed per tier and write touch. Backlogs drain over later saves. */
export const DECAY_FOLD_GROUP_LIMIT = 20

/**
 * A target window folds once all of it lies at or before this time, that is once
 * `targetWindowStart + edge.target <= foldCutoff`. The SQL folds state the same rule.
 */
export const foldCutoff = (edge: DecayEdge, now: number): number => now - edge.retainSeconds

/** The start of the edge's target window that contains `time`. */
export const targetWindowStart = (time: number, edge: DecayEdge): number =>
  Math.floor(time / edge.target) * edge.target
