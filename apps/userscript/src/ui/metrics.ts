/**
 * The handful of numbers our chrome is built out of, in one place so our surfaces start on one line.
 * A drift between them is visible the moment two are open at once, and they usually are, because
 * the menu configures what the panel lists.
 *
 * The rhythm is wplace's, not ours. Their rail is `top-2 right-2`, so 8px from the edge is where
 * chrome starts on this page; anything of ours using a different number reads as sitting slightly
 * wrong rather than as a deliberate choice.
 */

/** From the edge of the window. wplace's own inset, so our chrome starts where theirs does. */
export const EDGE = 8

/** Between two things of ours: rail button to rail button, rail to panel, menu to whatever it clears. */
export const GAP = 12

/** One rail button — wplace's `btn-circle` at the size they use, which ours are copies of. */
export const RAIL_BUTTON = 40

/** The right edge of anything that has to clear the rail, since the rail is always on top of it. */
export const CLEAR_OF_RAIL = EDGE + RAIL_BUTTON + GAP

/**
 * The open panel stacks above everything else on the page: Wplace's top overlays such as the
 * Territory Weekend scoreboard (z-index 1000) and the capture lobby card (up to 1001).
 */
export const PANEL_LAYER = '1002'

/** The template studio and claim editor, which open from the panel, stack just above it. */
export const EDITOR_LAYER = '1003'

/** Toasts stack above every surface of ours, so their actions are never covered. */
export const TOAST_LAYER = '1004'

/** The context menu's corner radius, shared by every rectangular Caelestis control and surface. */
export const SURFACE_RADIUS = 'calc(0.7rem + 1px)'
