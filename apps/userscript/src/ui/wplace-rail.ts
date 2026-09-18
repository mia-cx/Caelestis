const ANCHOR_LABELS = ['Overlays', 'Search', 'Leaderboard'] as const

/** Find Wplace's right-hand button rail from one of its own controls. */
export const findWplaceRail = (): Element | null => {
  const buttons = document.querySelectorAll('button')
  for (const anchorLabel of ANCHOR_LABELS) {
    for (const button of buttons) {
      const label = button.getAttribute('title') ?? button.getAttribute('aria-label') ?? ''
      if (label.trim() !== anchorLabel) continue
      const rail = button.parentElement
      if (rail !== null) return rail
    }
  }
  return null
}

/** The whole top-right Wplace control group, including wider account controls such as Log in. */
export const findWplaceRightControls = (): Element | null => {
  const rail = findWplaceRail()
  if (rail === null) return null
  const parent = rail.parentElement
  return parent === null || parent === document.body ? rail : parent
}

/** Whether an element is Caelestis chrome: inside our rail, a panel, or any of our custom elements. */
const isCaelestis = (element: Element): boolean => {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.id.startsWith('caelestis') || node.tagName.toLowerCase().startsWith('caelestis-'))
      return true
  }
  return false
}

/**
 * The top edge of the highest visible Wplace button under a column, or null when nothing is there.
 *
 * Measured rather than looked up by class because what sits under our rail changes with state:
 * My location and the profile button when idle, the paint drawer's own controls while painting.
 * Anything of ours is skipped so the rail never measures itself.
 */
export const wplaceButtonBelow = (column: {
  readonly left: number
  readonly right: number
  readonly top: number
}): number | null => {
  let nearest: number | null = null
  for (const button of document.querySelectorAll('button')) {
    const box = button.getBoundingClientRect()
    if (box.width === 0 || box.top < column.top) continue
    if (box.right <= column.left || box.left >= column.right) continue
    if (nearest !== null && box.top >= nearest) continue
    if (isCaelestis(button)) continue
    nearest = box.top
  }
  return nearest
}
