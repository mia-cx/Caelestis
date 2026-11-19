/**
 * Room Wplace's own map controls take from an overlay drawn over the map, in CSS pixels. The
 * studio's layout maths reads these numbers, and its CSS reads them as `--map-*` properties
 * (`MAP_CLEARANCE_STYLE`), so the two cannot drift.
 */
export const MAP_CLEARANCE = {
  /** Windows at the start edge clear the zoom buttons. */
  start: 48,
  /** Windows at the end edge clear the rail. */
  end: 56,
  /** Windows stop above the buttons along the bottom. */
  bottom: 76,
  /** At narrow widths, the bar sits between the zoom buttons and the account button. */
  barStart: 56,
  barEnd: 112,
  /** A phone sheet clears the bottom buttons, above the safe area. */
  sheetBottom: 68,
} as const

/** `MAP_CLEARANCE` as custom properties for a style attribute: `--map-start: 48px; …`. */
export const MAP_CLEARANCE_STYLE = Object.entries(MAP_CLEARANCE)
  .map(([side, pixels]) => `--map-${side}: ${pixels}px`)
  .join('; ')

/** Too narrow for the bar between two window columns: it wraps between Wplace's controls. */
export const NARROW_QUERY = '(max-width: 52rem)'
/** Too narrow for two 18rem windows side by side: one sheet along the bottom shows one at a time. */
export const PHONE_QUERY = '(max-width: 43rem)'
