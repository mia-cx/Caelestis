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

const template = async (folderId: string | null = null): Promise<string> => {
  const id = `move-hidden-${crypto.randomUUID()}`
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

/** Choose "Move" from a row's menu, the way the panel's tree does. */
const chooseMove = (key: string): void => {
  const callbacks = {
    onContextMenu: (target: TreeTarget, event: MouseEvent) =>
      openContextMenu(target, event, () => {}),
  } as Partial<TreeCallbacks> as TreeCallbacks
  templateTreeAdapter(callbacks, () => {}).handle({ type: 'context-menu', key, x: 0, y: 0 })
  const menu = treeActionPresentation().contextMenu
  const item = menu?.items.find((candidate) => candidate.label === 'Move')
  if (menu === undefined || item === undefined) throw new Error('Move is not offered')
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

describe('moving a hidden template from the panel', () => {
  it('shows a switched-off template so its placement can be seen', async () => {
    const id = await template()
    await store.setLocalVisible(id, false)

    chooseMove(`local:${id}`)

    await vi.waitFor(() => expect(movingId()).toBe(id))
    expect(store.templateById(id)?.visible).toBe(true)
  })

  it('refuses a template hidden by its folder and leaves the folder alone', async () => {
    const folder = createLocalFolder(null, 'Asleep')
    if (folder === null) throw new Error('folder could not be created')
    const id = await template(folder.id)
    setLocalFolderVisible(folder.id, false)

    chooseMove(`local:${id}`)

    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        '“Target” is in a hidden folder. Show the folder to move it.',
        'warning',
      ),
    )
    expect(movingId()).toBeNull()
    const placed = store.templateById(id)
    expect(placed !== undefined && store.isTemplateVisible(placed)).toBe(false)
  })
})
