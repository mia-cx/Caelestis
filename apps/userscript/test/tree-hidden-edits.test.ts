import { WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalFolder, setLocalFolderVisible } from '../src/local-folders.js'
import { type ServerConnection, setScopeVisible } from '../src/settings.js'
import * as catalog from '../src/templates/catalog.js'
import { abort, movingId } from '../src/templates/move.js'
import * as edits from '../src/templates/template-edits.js'
import { serverTemplateKey } from '../src/tree-keys.js'
import { showToast } from '../src/ui/notification-host.js'
import { templateTreeAdapter } from '../src/ui/tree.js'
import type { TreeCallbacks, TreeTarget } from '../src/ui/tree-context.js'

vi.mock('../src/claim-editor.js', () => ({ startCaptureMode: () => false }))
vi.mock('../src/map-view.js', () => ({ repaint: () => {}, viewportCentre: () => null }))
vi.mock('../src/ui/notification-host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/notification-host.js')>()),
  showToast: vi.fn(),
}))

import {
  handleTreeActionPresentationIntent,
  treeActionPresentation,
} from '../src/application/tree-presentation.js'
import { openContextMenu } from '../src/ui/tree-menu.js'

const folder = (name: string, parentId: string | null = null): string => {
  const created = createLocalFolder(parentId, name)
  if (created === null) throw new Error(`${name} could not be created`)
  return created.id
}

const template = async (folderId: string | null = null): Promise<string> => {
  const id = `hidden-edit-${crypto.randomUUID()}`
  await edits.addLocalTemplate(
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
  if (folderId !== null) await edits.setTemplateFolder(id, folderId)
  return id
}

/** Choose an entry from a row's menu, the way the panel's tree does. */
const choose = (key: string, label: string): void => {
  const callbacks = {
    onContextMenu: (target: TreeTarget, event: MouseEvent) =>
      openContextMenu(target, event, () => {}),
  } as Partial<TreeCallbacks> as TreeCallbacks
  templateTreeAdapter(callbacks, () => {}, { surface: WORLD_TEMPLATE_SURFACE }).handle({
    type: 'context-menu',
    key,
    x: 0,
    y: 0,
  })
  const menu = treeActionPresentation().contextMenu
  const item = menu?.items.find((candidate) => candidate.label === label)
  if (menu === undefined || item === undefined) throw new Error(`${label} is not offered`)
  handleTreeActionPresentationIntent({
    type: 'context-menu-action',
    menuId: menu.id,
    actionId: item.id,
  })
}

const MANIFEST_ONLY_KEY = serverTemplateKey(
  'https://hidden-edits.test',
  'manifest-only',
  WORLD_TEMPLATE_SURFACE,
)

afterEach(async () => {
  setScopeVisible(MANIFEST_ONLY_KEY, true)
  await abort()
  for (const placed of catalog.localTemplates()) await edits.removeLocalTemplate(placed.id)
  vi.mocked(showToast).mockClear()
})

describe('hidden templates and folders', () => {
  it('starts no placement on a switched-off template and leaves it hidden', async () => {
    const id = await template()
    await edits.setLocalVisible(id, false)

    choose(`local:${id}`, 'Move')

    expect(showToast).toHaveBeenCalledWith('“Target” is hidden. Show it first.', 'warning')
    expect(movingId()).toBeNull()
    expect(catalog.templateById(id)?.visible).toBe(false)
  })

  it('names the hidden folder rather than the template', async () => {
    const asleep = folder('Asleep')
    const id = await template(asleep)
    setLocalFolderVisible(asleep, false)

    choose(`local:${id}`, 'Move')

    expect(showToast).toHaveBeenCalledWith(
      '“Target” is in a hidden folder. Show the folder first.',
      'warning',
    )
    expect(movingId()).toBeNull()
  })

  it('refuses new artwork for a hidden server template whose pixels have not arrived', () => {
    const server: ServerConnection = {
      url: 'https://hidden-edits.test',
      info: null,
      token: 'admin',
      status: 'connected',
      isAdmin: true,
      season: 0,
    }
    setScopeVisible(MANIFEST_ONLY_KEY, false)
    const target: TreeTarget = {
      server,
      surface: WORLD_TEMPLATE_SURFACE,
      nodeId: null,
      key: 'manifest-only',
      name: 'Pending',
      templateId: 'manifest-only',
    }

    openContextMenu(target, new MouseEvent('contextmenu'), () => {})
    const menu = treeActionPresentation().contextMenu
    const item = menu?.items.find((candidate) => candidate.label === 'Replace artwork')
    if (menu === undefined || item === undefined) throw new Error('Replace artwork is not offered')
    handleTreeActionPresentationIntent({
      type: 'context-menu-action',
      menuId: menu.id,
      actionId: item.id,
    })

    expect(showToast).toHaveBeenCalledWith('“Pending” is hidden. Show it first.', 'warning')
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('adds nothing under a folder whose parent is hidden', () => {
    const outer = folder('Outer')
    const inner = folder('Inner', outer)
    setLocalFolderVisible(outer, false)

    choose(`lf:${inner}`, 'Import template')

    expect(showToast).toHaveBeenCalledWith(
      '“Inner” is in a hidden folder. Show the folder first.',
      'warning',
    )
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})
