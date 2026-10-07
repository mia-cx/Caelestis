import { resolveShortcutBindings } from '@caelestis/shared'
import { tick } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import { type CaelestisPanel, registerCaelestisUi } from '../src/elements/index.js'
import type { SettingsModel, TemplateTreeModel, TreeRowModel } from '../src/types.js'

afterEach(() => {
  document.body.replaceChildren()
})

const row = (key: string, depth: number, container = false, expanded = false): TreeRowModel =>
  ({
    type: 'row',
    key,
    name: key,
    icon: 'folder',
    depth,
    parentKey: depth === 0 ? null : 'folder',
    container,
    expanded,
    visible: true,
    setSize: 1,
    positionInSet: depth + 1,
  }) as TreeRowModel

const settingsModel = (): SettingsModel =>
  ({
    servers: [],
    colourNavigationOrder: 'unpainted-first',
    reportPaints: true,
    shareTiles: true,
    sharePresence: true,
    showPresence: true,
    showPresenceViewports: true,
    showPresenceClaims: true,
    showPresenceClaimsOnlyWhilePainting: false,
    debugLogging: false,
    performanceProfiling: false,
    notifyRegressions: true,
    notifyGriefing: false,
    notifyUpdates: true,
    notifyActivity: true,
    shortcuts: { platform: 'windows-linux', bindings: resolveShortcutBindings(), customised: true },
  }) as SettingsModel

const treeModel = (expanded: boolean): TemplateTreeModel =>
  ({
    query: '',
    sort: { field: 'custom', direction: 'asc' },
    entries: expanded
      ? [row('folder', 0, true, true), row('kid', 1), row('next', 0)]
      : [row('folder', 0, true, false), row('next', 0)],
  }) as TemplateTreeModel

describe('tree grow inside caelestis-panel element', () => {
  it('keeps collapsed rows mounted while the outro runs', async () => {
    registerCaelestisUi()
    const element = document.createElement('caelestis-panel') as CaelestisPanel
    element.model = {
      view: 'tree',
      width: 320,
      minWidth: 280,
      maxWidth: 400,
      tree: treeModel(true),
    } as never
    document.body.append(element)
    await tick()
    const s = element.shadowRoot!
    for (const el of s.querySelectorAll<HTMLElement>('[data-caelestis-tree-key]')) {
      el.style.setProperty('--caelestis-duration-fast', '80ms')
    }
    const kid = s.querySelector<HTMLElement>('[data-caelestis-tree-key="kid"]')!
    const folder = s.querySelector<HTMLElement>('[data-caelestis-tree-key="folder"]')!
    folder.click()
    await tick()
    element.model = {
      view: 'tree',
      width: 320,
      minWidth: 280,
      maxWidth: 400,
      tree: treeModel(false),
    } as never
    await tick()
    expect(kid.isConnected).toBe(true)
    // Stream in more model updates mid-outro (progress ticks), as the live host does.
    for (let i = 0; i < 3; i++) {
      element.model = {
        view: 'tree',
        width: 320,
        minWidth: 280,
        maxWidth: 400,
        tree: treeModel(false),
      } as never
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(kid.isConnected).toBe(false)
  })
})

describe('page slide inside caelestis-panel element', () => {
  it('overlaps outgoing and incoming pages during the swap', async () => {
    registerCaelestisUi()
    const element = document.createElement('caelestis-panel') as CaelestisPanel
    element.model = {
      view: 'tree',
      width: 320,
      minWidth: 280,
      maxWidth: 400,
      tree: treeModel(true),
      settings: settingsModel(),
    } as never
    document.body.append(element)
    await tick()
    const s = element.shadowRoot!
    for (const el of s.querySelectorAll<HTMLElement>('.page')) {
      el.style.setProperty('--caelestis-duration-fast', '80ms')
    }
    const pages = () => s.querySelectorAll('.page').length
    expect(pages()).toBe(1)
    element.model = {
      view: 'settings',
      width: 320,
      minWidth: 280,
      maxWidth: 400,
      tree: treeModel(true),
      settings: settingsModel(),
    } as never
    await tick()
    expect(pages()).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
})
