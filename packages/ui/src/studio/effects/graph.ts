/** The square the tone and curve graphs draw on, in SVG units. */
export const GRAPH_SIZE = 256
/** Edited values sit on the byte grid, as every editor's curves and levels do. */
export const BYTE = 255
/** Bytes a Shift+arrow press moves a point. */
export const LARGE_STEP = 16

/** Where a curve changes nothing: a remap's diagonal, an adjustment's midline, or a mask's top. */
export type Neutral = 'diagonal' | 'flat' | 'full'

/** Each neutral's dashed line on the graph: the SVG y of its left and right ends. */
export const NEUTRAL_LINE: Readonly<Record<Neutral, readonly [number, number]>> = {
  diagonal: [GRAPH_SIZE, 0],
  flat: [GRAPH_SIZE / 2, GRAPH_SIZE / 2],
  full: [0, 0],
}
