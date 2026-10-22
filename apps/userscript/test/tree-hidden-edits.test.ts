import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalFolder, setLocalFolderVisible } from '../src/local-folders.js'
import * as store from '../src/templates/local-store.js'
import { abort, movingId } from '../src/templates/move.js'
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

const template = async (folderId: string | null = null): Promise<string> => {
  const id = `hidden-edit-${crypto.randomUUID()}`
  await store.addLocalTemplate(
    {
      id,
      name: 'Target',
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

/** Choose an entry from a row's menu, the way the panel's tree does. */
const choose = (key: string, label: string): void => {
  const callbacks = {
    onContextMenu: (target: TreeTarget, event: MouseEvent) =>
      openContextMenu(target, event, () => {}),
  } as Partial<TreeCallbacks> as TreeCallbacks
  templateTreeAdapter(callbacks, () => {}).handle({ type: 'context-menu', key, x: 0, y: 0 })
  const menu = treeActionPresentation().contextMenu
  const item = menu?.items.find((candidate) => candidate.label === label)
  if (menu === undefined || item === undefined) throw new Error(`${label} is not offered`)
  handleTreeActionPresentationIntent({
    type: 'context-menu-action',
    menuId: menu.id,
    actionId: item.id,
  })
}

afterEach(async () => {
  await abort()
  for (const placed of store.localTemplates()) await store.removeLocalTemplate(placed.id)
  vi.mocked(toast).mockClear()
})

describe('hidden templates and folders', () => {
  it('starts no placement on a switched-off template and leaves it hidden', async () => {
    const id = await template()
    await store.setLocalVisible(id, false)

    choose(`local:${id}`, 'Move')

    expect(toast).toHaveBeenCalledWith('“Target” is hidden. Show it first.', 'warning')
    expect(movingId()).toBeNull()
    expect(store.templateById(id)?.visible).toBe(false)
  })

  it('names the hidden folder rather than the template', async () => {
    const asleep = folder('Asleep')
    const id = await template(asleep)
    setLocalFolderVisible(asleep, false)

    choose(`local:${id}`, 'Move')

    expect(toast).toHaveBeenCalledWith(
      '“Target” is in a hidden folder. Show the folder first.',
      'warning',
    )
    expect(movingId()).toBeNull()
  })

  it('adds nothing under a folder whose parent is hidden', () => {
    const outer = folder('Outer')
    const inner = folder('Inner', outer)
    setLocalFolderVisible(outer, false)

    choose(`lf:${inner}`, 'Import template')

    expect(toast).toHaveBeenCalledWith(
      '“Inner” is in a hidden folder. Show the folder first.',
      'warning',
    )
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})
