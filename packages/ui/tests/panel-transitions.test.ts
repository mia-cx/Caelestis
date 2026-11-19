import { tick } from 'svelte'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { registerCaelestisUi } from '../src/elements/index.js'
import type { PanelModel } from '../src/panel/model.js'
import type { TemplateTreeModel, TreeRowModel } from '../src/tree/model.js'

// Happy DOM has no top layer; real popover placement is a browser contract.
const showPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover')
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value() {} })
})
afterAll(() => {
  if (showPopover !== undefined)
    Object.defineProperty(HTMLElement.prototype, 'showPopover', showPopover)
  else Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
})
afterEach(() => {
  document.body.replaceChildren()
})

const row = (key: string, depth: number, container = false, expanded = false): TreeRowModel => ({
  type: 'row',
  key,
  name: key,
  icon: 'folder',
  depth,
  parentKey: depth === 0 ? null : 'folder',
  container,
  expanded,
  visible: true,
})

const panel = (tree: TemplateTreeModel): PanelModel => ({
  view: 'tree',
  width: 320,
  minWidth: 280,
  maxWidth: 400,
  tree,
})

const treeModel = (expanded: boolean): TemplateTreeModel => ({
  query: '',
  sort: { field: 'custom', direction: 'asc' },
  entries: expanded
    ? [row('folder', 0, true, true), row('kid', 1), row('next', 0)]
    : [row('folder', 0, true, false), row('next', 0)],
})

describe('tree grow inside caelestis-panel element', () => {
  it('keeps collapsed rows through model updates until their exit animation ends', async () => {
    registerCaelestisUi()
    const element = document.createElement('caelestis-panel')
    element.model = panel(treeModel(true))
    document.body.append(element)
    await tick()
    const s = element.shadowRoot!
    s.querySelector<HTMLElement>('.tree')!.style.setProperty('--caelestis-duration-fast', '80ms')
    const kid = s.querySelector<HTMLElement>('[data-caelestis-tree-key="kid"]')!
    s.querySelector<HTMLElement>('[data-caelestis-tree-key="folder"]')!.click()
    await tick()
    element.model = panel(treeModel(false))
    await tick()
    // Progress ticks stream fresh models mid-exit, as the live host does.
    for (let i = 0; i < 3; i++) {
      element.model = panel(treeModel(false))
      await tick()
    }
    expect(kid.isConnected).toBe(true)
    expect(kid.inert).toBe(true)
    for (const animation of kid.getAnimations()) animation.finish()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await tick()
    expect(kid.isConnected).toBe(false)
  })
})

const menuTree = (): TemplateTreeModel => ({
  query: '',
  sort: { field: 'custom', direction: 'asc' },
  entries: [
    {
      ...row('art', 0),
      icon: 'image',
      progress: { completed: 50, mismatched: 20, unpainted: 30, known: 100, total: 100 },
    },
  ],
  contextMenu: {
    id: 'actions',
    rowKey: 'art',
    x: 20,
    y: 20,
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

describe('context menu inside caelestis-panel element', () => {
  it('keeps an open menu and submenu steady across model refreshes', async () => {
    registerCaelestisUi()
    const element = document.createElement('caelestis-panel')
    let tree = menuTree()
    element.model = panel(tree)
    document.body.append(element)
    await tick()
    const s = element.shadowRoot!
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const menu = s.querySelector<HTMLElement>('[data-caelestis-context-menu]')!
    expect(menu).not.toBeNull()
    for (let frame = 0; frame < 60 && menu.dataset.state !== 'open'; frame++) await nextFrame()
    expect(menu.dataset.state).toBe('open')
    s.querySelector<HTMLButtonElement>('[data-submenu="move"] > button')!.click()
    await tick()
    await tick()
    await nextFrame()
    const child = s.querySelector<HTMLButtonElement>('[role="menu"][aria-label="Move to"] button')!
    expect(child).not.toBeNull()
    expect(s.activeElement).toBe(child)
    const flickers: MutationRecord[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records)
        if (menu.style.visibility === 'hidden' || menu.dataset.state !== 'open')
          flickers.push(record)
    })
    observer.observe(menu, { attributes: true, attributeFilter: ['style', 'data-state'] })
    for (let refresh = 0; refresh < 3; refresh++) {
      tree = {
        ...tree,
        entries: tree.entries.map((entry) =>
          entry.type === 'row' && entry.progress
            ? { ...entry, progress: { ...entry.progress, completed: entry.progress.completed + 1 } }
            : entry,
        ),
      }
      element.model = panel(tree)
      await nextFrame()
      await nextFrame()
    }
    await nextFrame()
    observer.disconnect()
    expect(flickers).toEqual([])
    expect(s.querySelector('[data-caelestis-context-menu]')).toBe(menu)
    expect(menu.dataset.state).toBe('open')
    expect(s.querySelector('[role="menu"][aria-label="Move to"]')).not.toBeNull()
    expect(s.activeElement).toBe(child)
  })
})

describe('rename from the context menu', () => {
  it('runs the action from the row that opened the menu, then leaves the name selected in the rename field', async () => {
    registerCaelestisUi()
    const element = document.createElement('caelestis-panel')
    const { contextMenu: _, ...withoutMenu } = menuTree()
    element.model = panel(withoutMenu)
    document.body.append(element)
    await tick()
    const s = element.shadowRoot!
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    s.querySelector<HTMLElement>('[data-caelestis-tree-key="art"]')!.focus()
    element.model = panel(menuTree())
    await tick()
    const menu = s.querySelector<HTMLElement>('[data-caelestis-context-menu]')!
    for (let frame = 0; frame < 60 && menu.dataset.state !== 'open'; frame++) await nextFrame()
    // The host closes the menu and starts the rename in one update, as the userscript does.
    // Whatever the action opens (here a rename field, elsewhere a dialog) sees the row focused.
    let focusedWhenRun: Element | null = null
    element.addEventListener(
      'caelestis-panel-intent',
      () => {
        focusedWhenRun = s.activeElement
        element.model = panel({ ...withoutMenu, renamingKey: 'art' })
      },
      { once: true },
    )
    s.querySelector<HTMLButtonElement>('[data-caelestis-context-menu] [role="menuitem"]')!.click()
    expect(focusedWhenRun).toBe(s.querySelector('[data-caelestis-tree-key="art"]'))
    await tick()
    await nextFrame()
    await nextFrame()
    const field = s.querySelector<HTMLInputElement>('input[aria-label="Rename art"]')!
    expect(s.activeElement).toBe(field)
    // The whole name is selected, so typing replaces it.
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'art'.length])
  })
})
