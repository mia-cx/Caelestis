import { frameQueue } from './frame-queue.js'

const ANCHOR_LABELS = ['Overlays', 'Search', 'Leaderboard'] as const

/**
 * The space between two of Wplace's rail buttons, or null while fewer than two are on screen.
 *
 * Measured because it differs by theme: 12px in the classic UI, 8px in the pixel game UI.
 */
export const wplaceRailGap = (rail: Element): number | null => {
  const [first, second] = [...rail.children]
    .map((child) => child.getBoundingClientRect())
    .filter((box) => box.height > 0)
  return first === undefined || second === undefined ? null : second.top - first.bottom
}

/** Whether an element is Caelestis chrome: inside our rail, a panel, or any of our custom elements. */
const isCaelestis = (element: Element): boolean => {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.id.startsWith('caelestis') || node.tagName.toLowerCase().startsWith('caelestis-'))
      return true
  }
  return false
}

const isCaelestisNode = (node: Node): boolean => node instanceof Element && isCaelestis(node)

/**
 * Whether a mutation is Wplace's own. A record is ours when it happened on or inside our nodes, or
 * when everything it added or removed was one of our nodes; a batch that mixes both still counts.
 */
export const isWplaceMutation = (record: MutationRecord): boolean => {
  if (record.target instanceof Element && isCaelestis(record.target)) return false
  if (record.type !== 'childList') return true
  for (const node of record.addedNodes) if (!isCaelestisNode(node)) return true
  for (const node of record.removedNodes) if (!isCaelestisNode(node)) return true
  return false
}

const layoutListeners = new Set<() => void>()
let watching = false
/** Whether Wplace's DOM may have changed since the last rail scan. */
let railStale = true
/** The Wplace button the rail was found from; its parent is the rail wherever it moves. */
let anchor: Element | null = null

const notifyLayout = frameQueue(() => {
  for (const listener of layoutListeners) listener()
})

/** One observer for the whole page, installed the first time anything asks about Wplace's layout. */
const watchWplaceLayout = (): boolean => {
  if (watching) return true
  if (document.body === null) return false
  watching = true
  new MutationObserver((records) => {
    if (!records.some(isWplaceMutation)) return
    railStale = true
    notifyLayout()
  }).observe(document.body, { childList: true, subtree: true })
  // Their paint drawer slides in after the mutation that adds it; the end of that slide is the
  // moment the buttons below our rail settle.
  for (const type of ['transitionend', 'animationend'])
    document.addEventListener(
      type,
      (event) => {
        if (event.target instanceof Element && !isCaelestis(event.target)) notifyLayout()
      },
      true,
    )
  return true
}

/**
 * Call `listener` at most once per frame after Wplace adds or removes DOM nodes, or finishes a
 * transition. Our own nodes never count, so positioning them cannot wake this again.
 */
export const onWplaceLayoutChange = (listener: () => void): void => {
  layoutListeners.add(listener)
  watchWplaceLayout()
}

const scanForAnchor = (): Element | null => {
  const buttons = document.querySelectorAll('button')
  for (const anchorLabel of ANCHOR_LABELS) {
    for (const button of buttons) {
      const label = button.getAttribute('title') ?? button.getAttribute('aria-label') ?? ''
      if (label.trim() === anchorLabel && button.parentElement !== null) return button
    }
  }
  return null
}

/**
 * Find Wplace's right-hand button rail from one of its own controls.
 *
 * The control is scanned for once and kept while it stays in the document; the rail is its
 * current parent, so a re-render that moves it is followed for free. While painting there is no
 * rail, and the scan reruns only after Wplace's DOM has changed.
 */
export const findWplaceRail = (): Element | null => {
  if (anchor?.isConnected !== true && (anchor !== null || railStale)) {
    // Without a body there is nothing to observe, so nothing would mark a cached miss stale.
    railStale = !watchWplaceLayout()
    anchor = scanForAnchor()
  }
  return anchor?.parentElement ?? null
}

/** The whole top-right Wplace control group, including wider account controls such as Log in. */
export const findWplaceRightControls = (): Element | null => {
  const rail = findWplaceRail()
  if (rail === null) return null
  const parent = rail.parentElement
  return parent === null || parent === document.body ? rail : parent
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
