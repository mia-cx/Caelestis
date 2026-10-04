import {
  type PanelIntent,
  registerCaelestisUi,
  type TemplateTreeModel,
} from '@caelestis/ui/elements'
import { surfaceCloseDurationMs } from '@caelestis/ui/motion'
import { requestConfirmation } from '../src/ui/notification-host.js'
import { applyWplaceTheme } from '../src/ui/theme.js'

declare global {
  interface Window {
    browserInput: (
      input: { key: string } | { x: number; y: number; button?: 'left' | 'right' },
    ) => Promise<void>
  }
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const until = async (condition: () => boolean, message: string) => {
  const deadline = performance.now() + 2000
  while (!condition()) {
    assert(performance.now() < deadline, message)
    await frame()
  }
}
const settled = async (node: HTMLElement) => {
  await frame()
  for (const animation of node.getAnimations({ subtree: true })) animation.finish()
  await frame()
}
const click = async (node: HTMLElement, button: 'left' | 'right' = 'left') => {
  const rect = node.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const root = node.getRootNode() as ShadowRoot
  assert(
    root.elementFromPoint(x, y)?.closest('button, [role="treeitem"]') === node,
    `Clipped or inert click target: ${node.getAttribute('aria-label') ?? node.textContent}`,
  )
  await window.browserInput({ x, y, button })
}
const key = (key: string) => window.browserInput({ key })

// Control only removal deadlines, not rAF or CSS: a slow CDP round trip cannot consume a 150ms exit.
// The real closeSurface callback and its computed production duration still determine removal.
const removalClock = () => {
  const set = window.setTimeout
  const clear = window.clearTimeout
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  window.setTimeout = ((run: TimerHandler, delay = 0, ...args: unknown[]) => {
    assert(typeof run === 'function', 'Unexpected string timer in surface contract')
    timers.set(++id, { at: now + delay, run: () => run(...args) })
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = (id) => {
    if (id !== undefined) timers.delete(id)
  }
  return {
    advance(ms: number) {
      now += ms
      for (const [id, timer] of timers)
        if (timer.at <= now) {
          timers.delete(id)
          timer.run()
        }
    },
    restore() {
      window.setTimeout = set
      window.clearTimeout = clear
      timers.clear()
    },
  }
}

const sampleExit = async (node: HTMLElement, label: string) => {
  const duration = surfaceCloseDurationMs(node)
  assert(duration > 0, `${label}: production close duration is missing`)
  await frame()
  assert(
    node.isConnected && node.dataset.state === 'closing',
    `${label}: original closing node was unmounted`,
  )
  const animations = node.getAnimations()
  const fade = animations.find(
    (animation) => animation instanceof CSSTransition && animation.transitionProperty === 'opacity',
  )
  assert(
    fade?.effect?.getComputedTiming().duration === duration,
    `${label}: CSS exit and removal deadline disagree`,
  )
  for (const animation of animations) {
    animation.pause()
    animation.currentTime = duration / 2
  }
  const opacity = Number(getComputedStyle(node).opacity)
  assert(
    opacity > 0 && opacity < 1 && node.getBoundingClientRect().height > 0,
    `${label}: exit shell is not visibly transitioning (${opacity})`,
  )
  assert(
    getComputedStyle(node).pointerEvents === 'none',
    `${label}: closing surface still accepts clicks`,
  )
  return duration
}

/** Real custom-element, top-layer, focus-scroll and native-dialog contracts for PR580. */
export const runPanelSurfaceContracts = async () => {
  registerCaelestisUi()
  const host = document.createElement('caelestis-panel')
  host.id = 'caelestis-panel'
  host.dataset.state = 'open'
  host.style.cssText = 'position:fixed;left:260px;top:150px;height:430px;overflow:hidden'
  applyWplaceTheme(host)
  let tree: TemplateTreeModel = {
    query: '',
    sort: { field: 'name', direction: 'asc' },
    displayMode: 'tree',
    entries: [
      {
        type: 'row',
        key: 'art',
        name: 'Artwork',
        icon: 'image',
        depth: 0,
        parentKey: null,
        container: false,
        expanded: false,
        visible: true,
        contextMenu: true,
        setSize: 1,
        positionInSet: 1,
        progress: { completed: 50, mismatched: 20, unpainted: 30, known: 100, total: 100 },
      },
    ],
  }
  const update = (next: Partial<TemplateTreeModel>) => {
    tree = { ...tree, ...next }
    host.model = { view: 'tree', width: 320, minWidth: 260, maxWidth: 720, tree }
  }
  let menuSequence = 0
  const actions: string[] = []
  const popouts: boolean[] = []
  host.addEventListener('caelestis-panel-intent', (event) => {
    const intent = (event as CustomEvent<PanelIntent>).detail
    if (intent.type === 'popout') {
      popouts.push(intent.open)
      return
    }
    if (intent.type !== 'tree') return
    const action = intent.intent
    if (action.type === 'context-menu')
      update({
        contextMenu: {
          id: `menu-${++menuSequence}`,
          rowKey: action.key,
          x: action.x,
          y: action.y,
          items: [
            { id: 'rename', label: 'Rename', icon: 'rename' },
            {
              id: 'move',
              label: 'Move to',
              icon: 'move',
              children: [{ id: 'folder', label: 'Destination folder', icon: 'folder' }],
            },
          ],
        },
      })
    if (action.type === 'dismiss-context-menu') update({ contextMenu: undefined })
    if (action.type === 'context-menu-action') {
      actions.push(action.actionId)
      update({ contextMenu: undefined })
    }
    if (action.type === 'display-mode') update({ displayMode: action.mode })
  })
  update({})
  document.body.append(host)
  await until(
    () => host.shadowRoot?.querySelector('[role="treeitem"]') != null,
    'Panel custom element did not mount',
  )
  const root = host.shadowRoot
  assert(root !== null, 'Panel did not create a shadow root')
  const find = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const node = root.querySelector<T>(selector)
    assert(node !== null, `Missing panel control: ${selector}`)
    return node
  }
  const button = (label: string) => find<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const clock = removalClock()
  // Freeze exit frames before CDP returns, then sample the real CSS transition at its midpoint.
  const exits = new MutationObserver((records) => {
    for (const { target } of records) {
      if (!(target instanceof HTMLElement) || target.dataset.state !== 'closing') continue
      for (const animation of target.getAnimations()) {
        animation.pause()
        animation.currentTime = 0
      }
    }
  })
  exits.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-state'] })
  let maxScrollLeft = 0
  let scrollFrame = 0
  const sampleScroll = () => {
    maxScrollLeft = Math.max(
      maxScrollLeft,
      host.scrollLeft,
      ...[...root.querySelectorAll<HTMLElement>('*')].map((node) => node.scrollLeft),
    )
    scrollFrame = requestAnimationFrame(sampleScroll)
  }
  sampleScroll()
  const removed = async (node: HTMLElement, duration: number, label: string) => {
    clock.advance(duration - 1)
    await frame()
    assert(node.isConnected, `${label}: removed before CSS close deadline`)
    clock.advance(1)
    await until(() => !node.isConnected, `${label}: retained after CSS close deadline`)
  }
  try {
    await settled(host)
    assert(
      getComputedStyle(host).transform !== 'none',
      'Fixture lost the production transformed host',
    )
    assert(
      host.getBoundingClientRect().left > 0 && getComputedStyle(host).overflow === 'hidden',
      'Fixture must exercise an offset, clipping panel',
    )
    for (const poppedOut of [false, true]) {
      if (poppedOut) {
        await click(button('Pop out menu'))
        await until(
          () => root.querySelector('dialog')?.open === true,
          'Popout did not become modal',
        )
        await settled(find('dialog'))
      }
      const row = find('[role="treeitem"]')
      await click(row, 'right')
      const menu = find('[data-caelestis-context-menu]')
      await settled(menu)
      const anchor = tree.contextMenu
      assert(anchor !== undefined, 'Context-menu intent did not update the model')
      const rect = menu.getBoundingClientRect()
      assert(
        Math.abs(rect.left - anchor.x) < 1 && Math.abs(rect.top - anchor.y) < 1,
        `${poppedOut ? 'Popout' : 'Docked'} menu is not viewport positioned: ${rect.left},${rect.top} vs ${anchor.x},${anchor.y}; ${getComputedStyle(menu).transform}`,
      )
      const rename = find('[data-caelestis-context-menu] button')
      assert(root.activeElement === rename, 'Menu did not receive keyboard focus')
      await key('ArrowDown')
      await key('ArrowRight')
      await until(
        () => root.querySelector('[role="menu"][aria-label="Move to"]') !== null,
        'Keyboard did not open submenu',
      )
      const submenu = find('[role="menu"][aria-label="Move to"]')
      const child = find('[role="menu"][aria-label="Move to"] button')
      const trigger = find('[data-caelestis-context-menu] [aria-haspopup="menu"]')
      const box = submenu.getBoundingClientRect()
      const triggerBox = trigger.getBoundingClientRect()
      const expectedLeft =
        triggerBox.right + box.width > innerWidth - 8
          ? triggerBox.left - box.width
          : triggerBox.right
      assert(
        Math.abs(box.left - expectedLeft) < 1 && Math.abs(box.top - (triggerBox.top - 4)) < 1,
        'Submenu was shifted by the transformed or scrolling parent menu',
      )
      assert(
        box.left >= 8 &&
          box.right <= innerWidth - 8 &&
          box.top >= 8 &&
          box.bottom <= innerHeight - 8,
        'Submenu escaped the viewport',
      )
      assert(root.activeElement === child, 'Submenu did not receive keyboard focus')
      await key('ArrowLeft')
      assert(root.activeElement === trigger, 'Submenu close did not restore trigger focus')
      await key('ArrowRight')
      await until(
        () => root.querySelector('[role="menu"][aria-label="Move to"]') !== null,
        'Keyboard did not reopen submenu',
      )
      await click(find('[role="menu"][aria-label="Move to"] button'))
      assert(actions.at(-1) === 'folder', 'Submenu click did not reach the model owner')
      const duration = await sampleExit(menu, 'Menu dismissal')
      await click(row, 'right')
      await frame()
      assert(
        find('[data-caelestis-context-menu]') === menu && menu.dataset.state === 'open',
        'Menu reopen replaced the retained node instead of cancelling close',
      )
      clock.advance(duration + 1)
      await settled(menu)
      assert(menu.isConnected, 'Cancelled menu close removed the reopened menu')
      assert(
        root.activeElement === rename,
        `Reopened menu lost focus to ${root.activeElement?.outerHTML}`,
      )
      await key('Enter')
      assert(actions.at(-1) === 'rename', 'Keyboard menu activation did not reach the owner')
      await sampleExit(menu, 'Keyboard menu dismissal')
      await removed(menu, duration, 'Menu')
      await click(row, 'right')
      const dismissed = find('[data-caelestis-context-menu]')
      await settled(dismissed)
      await key('Escape')
      assert(tree.contextMenu === undefined, 'Escape did not dismiss the live menu model')
      if (poppedOut)
        assert(find<HTMLDialogElement>('dialog').open, 'Menu Escape also docked popout')
      await removed(dismissed, await sampleExit(dismissed, 'Menu Escape'), 'Dismissed menu')
      assert(
        maxScrollLeft === 0,
        `${poppedOut ? 'Popout' : 'Docked'} menu focus horizontally scrolled the panel`,
      )
    }

    await click(button('Preview grid view'))
    await frame()
    await click(button('View progress for Artwork'))
    const pane = find('.progress-pane')
    await settled(pane)
    await click(button('Close progress'))
    const paneDuration = await sampleExit(pane, 'Progress close')
    await click(button('View progress for Artwork'))
    await frame()
    assert(
      find('.progress-pane') === pane && pane.dataset.state === 'open',
      'Progress reopen did not retain and reverse the original pane',
    )
    clock.advance(paneDuration + 1)
    await settled(pane)
    assert(pane.isConnected, 'Cancelled progress close removed the reopened pane')
    await key('Escape')
    await sampleExit(pane, 'Progress Escape')
    await removed(pane, paneDuration, 'Progress')
    assert(find<HTMLDialogElement>('dialog').open, 'Progress Escape also docked the popout')

    for (const path of ['button', 'escape']) {
      const dialog = find<HTMLDialogElement>('dialog')
      if (path === 'button') await click(button('Return to sidebar'))
      else await key('Escape')
      assert(
        !dialog.open && !dialog.matches(':modal') && popouts.at(-1) === false,
        `${path}: popout modality/owner remained active during exit`,
      )
      const duration = await sampleExit(dialog, `Popout ${path}`)
      await removed(dialog, duration, `Popout ${path}`)
      await until(() => root.activeElement === button('Pop out menu'), 'Dock did not restore focus')
      if (path === 'button') {
        await click(button('Pop out menu'))
        await until(() => root.querySelector('dialog')?.open === true, 'Second popout did not open')
        await settled(find('dialog'))
      }
    }

    for (const path of ['confirm', 'escape']) {
      const invoker = button('Pop out menu')
      let answer: boolean | undefined
      const pending = requestConfirmation({
        title: 'Delete artwork',
        body: 'Delete this template?',
        note: 'Permanent.',
        confirmLabel: 'Delete',
        restoreFocusTo: invoker,
      }).then((value) => {
        answer = value
      })
      const owner = document.querySelector('caelestis-notifications')
      assert(owner !== null, 'Real confirmation owner did not mount')
      await until(
        () => owner.shadowRoot?.querySelector('dialog')?.open === true,
        'Confirmation did not open',
      )
      const ownerRoot = owner.shadowRoot
      assert(ownerRoot !== null, 'Notifications did not create a shadow root')
      exits.observe(ownerRoot, { subtree: true, attributes: true, attributeFilter: ['data-state'] })
      const dialog = ownerRoot.querySelector('dialog')
      assert(dialog !== null, 'Confirmation dialog disappeared before answering')
      await settled(dialog)
      if (path === 'confirm') {
        const confirm = dialog.querySelector<HTMLButtonElement>('.danger')
        assert(confirm !== null, 'Confirmation has no confirm button')
        await click(confirm)
      } else await key('Escape')
      await until(
        () => answer !== undefined,
        `${path}: confirmation owner waited for visual removal`,
      )
      await pending
      assert(
        answer === (path === 'confirm') && owner.model.confirm === null,
        `${path}: real confirmation owner did not resolve immediately`,
      )
      assert(
        !dialog.open && !dialog.matches(':modal'),
        `${path}: confirmation retained native modality`,
      )
      invoker.focus()
      assert(root.activeElement === invoker, 'Closing confirmation left the panel inert')
      const duration = await sampleExit(dialog, `Confirmation ${path}`)
      await removed(dialog, duration, `Confirmation ${path}`)
    }
    return { viewportMenus: 2, retainedProgress: true, nativeDialogExits: 4 }
  } finally {
    cancelAnimationFrame(scrollFrame)
    exits.disconnect()
    clock.restore()
    document.querySelector('caelestis-notifications')?.remove()
    host.remove()
  }
}
