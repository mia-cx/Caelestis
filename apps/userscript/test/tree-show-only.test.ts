import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalFolder, setLocalFolderVisible } from '../src/local-folders.js'
import { setScopeVisible } from '../src/state.js'
import * as store from '../src/templates/local-store.js'
import { toast } from '../src/ui/toast.js'
import { type TreeCallbacks, type TreeTarget, templateTreeAdapter } from '../src/ui/tree.js'

vi.mock('../src/claim-editor.js', () => ({ startCaptureMode: () => false }))
vi.mock('../src/main.js', () => ({ repaint: () => {}, viewportCentre: () => null }))
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }))

import {
  handleTreeActionPresentationIntent,
  openContextMenu,
  treeActionPresentation,
} from '../src/application/tree-actions.js'

const folder = (name: string, parentId: string | null = null): string => {
  const created = createLocalFolder(parentId, name)
  if (created === null) throw new Error(`${name} could not be created`)
  return created.id
}

const template = async (name: string, folderId: string | null): Promise<string> => {
  const id = `show-only-${crypto.randomUUID()}`
  await store.addLocalTemplate(
    {
      id,
      name,
      source: 'wplace',
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      indices: new Uint8Array([1]),
      moved: 0,
      opaque: 1,
    },
    undefined,
    true,
  )
  if (folderId !== null) await store.setTemplateFolder(id, folderId)
  return id
}

const shown = (id: string): boolean => {
  const placed = store.templateById(id)
  if (placed === undefined) throw new Error(`${id} is missing`)
  return store.isTemplateVisible(placed)
}

/** Choose "Show only this" from a row's menu, the way the panel's tree does. */
const chooseShowOnly = (key: string, query = ''): void => {
  const callbacks = {
    onContextMenu: (target: TreeTarget, event: MouseEvent) =>
      openContextMenu(target, event, () => {}),
  } as Partial<TreeCallbacks> as TreeCallbacks
  templateTreeAdapter(callbacks, () => {}, query).handle({ type: 'context-menu', key, x: 0, y: 0 })
  const menu = treeActionPresentation().contextMenu
  const item = menu?.items.find((candidate) => candidate.label === 'Show only this')
  if (menu === undefined || item === undefined) throw new Error('Show only this is not offered')
  handleTreeActionPresentationIntent({
    type: 'context-menu-action',
    menuId: menu.id,
    actionId: item.id,
  })
}

afterEach(async () => {
  setScopeVisible('local', true)
  for (const placed of store.localTemplates()) await store.removeLocalTemplate(placed.id)
})

describe('show only this', () => {
  it('leaves one template drawn in its folder and reveals nothing else on the way up', async () => {
    const outer = folder('Outer')
    const inner = folder('Inner', outer)
    const nested = folder('Nested', inner)
    const asleep = folder('Asleep')
    const target = await template('Target', inner)
    const peer = await template('Peer', inner)
    const deep = await template('Deep', nested)
    const outerPeer = await template('Outer peer', outer)
    const elsewhere = await template('Elsewhere', null)
    const stillHidden = await template('Still hidden', asleep)
    await store.setLocalVisible(target, false)
    setLocalFolderVisible(outer, false)
    setLocalFolderVisible(asleep, false)

    // The search lists only Target; its peers must be hidden by folder, not by what is listed.
    chooseShowOnly(`local:${target}`, 'target')

    // Shown: the target and the template outside its path. Hidden: its peers and what was hidden.
    await vi.waitFor(() =>
      expect([target, elsewhere, peer, deep, outerPeer, stillHidden].map(shown)).toEqual([
        true,
        true,
        false,
        false,
        false,
        false,
      ]),
    )
    expect(toast).not.toHaveBeenCalled()

    // A hidden subfolder keeps its own arrangement for when it is switched back on.
    setLocalFolderVisible(nested, true)
    expect(shown(deep)).toBe(true)
  })

  // Outer and Inner are switched on, but nothing in them is drawn until the switch above is on.
  it.each([
    [
      'the Local source',
      (): null => {
        setScopeVisible('local', false)
        return null
      },
    ],
    [
      'a distant folder',
      (): string => {
        const top = folder('Top')
        setLocalFolderVisible(top, false)
        return top
      },
    ],
  ])('keeps a switched-on folder quiet when %s above it was hiding it', async (_, hiddenAbove) => {
    const outer = folder('Outer', hiddenAbove())
    const inner = folder('Inner', outer)
    const target = await template('Target', inner)
    const outerPeer = await template('Outer peer', outer)

    chooseShowOnly(`local:${target}`)

    await vi.waitFor(() => expect([target, outerPeer].map(shown)).toEqual([true, false]))
  })

  it('reports a switch that could not be saved', async () => {
    const group = folder('Group')
    const target = await template('Target', group)
    await template('Peer', group)
    vi.spyOn(store, 'setLocalVisible').mockResolvedValueOnce(false)

    chooseShowOnly(`local:${target}`)

    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Could not change visibility for “Target”.', 'error'),
    )
  })
})
