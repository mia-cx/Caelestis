/**
 * Which presence items the pointer is over right now, by the layer's item keys: `region:<id>` for
 * a claim and `peer:<session>:viewport` for a painter's viewport. The name tags find them each
 * frame; the presence layer reads them to let your own claim's fill, or any viewport's, step
 * aside while you paint inside it. A tiny module of its own so neither side has to import the
 * other.
 */

let hovered: ReadonlySet<string> = new Set()
const listeners: (() => void)[] = []

export const hoveredPresenceItems = (): ReadonlySet<string> => hovered

/** Replace the hovered set; listeners run only when it actually changed. */
export const setHoveredPresenceItems = (keys: ReadonlySet<string>): void => {
  if (keys.size === hovered.size && [...keys].every((key) => hovered.has(key))) return
  hovered = new Set(keys)
  for (const listener of listeners) listener()
}

export const onPresenceHoverChange = (listener: () => void): void => {
  listeners.push(listener)
}

/** Test seam. */
export const resetPresenceHover = (): void => {
  hovered = new Set()
  listeners.length = 0
}
