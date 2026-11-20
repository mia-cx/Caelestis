import { authoringOf } from '../application/template-authoring.js'
import { templateBusy } from '../application/template-busy.js'
import {
  type MenuEntry,
  type MenuGroups,
  showContextMenu,
} from '../application/tree-presentation.js'
import { warn } from '../debug.js'
import { serverAlarmFor } from '../server-alarms.js'
import { dismissTemplateAlarm } from '../server-api.js'
import { hasServerAdminToken } from '../server-connections.js'
import { requestServerSync } from '../server-sync-coordinator.js'
import { templateById } from '../templates/catalog.js'
import { beginMove } from '../templates/move.js'
import { templateAsPng } from '../templates/residency.js'
import { exportFilename, templateAsWplace } from '../templates/wplace-export.js'
import { localTemplateIdOf, serverTemplateKey } from '../tree-keys.js'
import { canBackfill, openBackfill } from './backfill.js'
import { showToast } from './notification-host.js'
import {
  requestTemplateAreaUpdate,
  requestTemplateArtworkUpdate,
} from './template-artwork-update.js'
import type { TreeTarget } from './tree-context.js'
import { copyToServer } from './tree-copy.js'
import { deleteTreeRow } from './tree-delete.js'
import { createFolder } from './tree-folders.js'
import { captureTemplate, createFromImage, download, importTemplate } from './tree-import.js'
import { goToLocalTemplate, goToServerTemplate } from './tree-navigation.js'
import {
  folderTemplatesFor,
  moveServerTemplate,
  patchServerTemplate,
  replaceFromImage,
  replaceServerArtwork,
  setServerFolderPublished,
  templateStateOf,
} from './tree-server-template.js'
import { hiddenNotice } from './tree-target.js'
import { startRenaming } from './tree-view-state.js'
import { canClaimTemplate, claimTemplate, hasOwnTemplateClaim } from './work.js'

/** `.wplace` carries placement and authoring for Wplace and Caelestis; `.png` is the artwork alone. */
const exportTemplate = async (target: TreeTarget, format: 'wplace' | 'png'): Promise<void> => {
  const localId = localTemplateIdOf(target.key)
  const id =
    localId ??
    (target.server !== null && target.templateId !== undefined
      ? serverTemplateKey(target.server.url, target.templateId, target.surface)
      : null)
  const template = id === null ? undefined : templateById(id)
  if (template === undefined) {
    showToast('That template has not finished loading yet.', 'warning')
    return
  }
  // A template that was never placed has no origin to export yet.
  if (!template.everPlaced || templateBusy(template.id, 'placing')) {
    showToast(`Finish placing “${template.name}” before exporting it.`, 'warning')
    return
  }

  showToast(`Preparing “${template.name}”…`)
  try {
    const file =
      format === 'png'
        ? await templateAsPng(template)
        : await templateAsWplace(template, await authoringOf(template))
    if (file === null) {
      showToast(`“${template.name}” changed while it was being exported. Try again.`, 'warning')
      return
    }
    download(file, exportFilename(template.name, format))
    showToast(`Exported “${template.name}”.`)
  } catch (error) {
    warn(`could not export ${template.name}`, String(error))
    showToast(`Could not export “${template.name}”.`, 'error')
  }
}

/**
 * A right-click menu carrying the row's actions plus the ones deliberately kept off it.
 *
 * Move and Delete are here rather than on the row because a row action sits under the cursor
 * during an ordinary hover: Move takes over the canvas and Delete destroys the template, and
 * neither should be one stray click away. The template's own menu on the canvas carries them too.
 *
 * Dismissed by the next pointerdown anywhere, which is what every native menu does and what people
 * try first.
 */
export const openContextMenu = (
  target: TreeTarget,
  event: MouseEvent,
  rerender: () => void,
): void => {
  const { surface } = target
  const templateId = localTemplateIdOf(target.key)
  const artworkId =
    target.server !== null && target.templateId !== undefined
      ? serverTemplateKey(target.server.url, target.templateId, surface)
      : templateId
  /** Run an edit to the template's placement or art unless the map hides it. */
  const whenDrawn = (edit: (id: string) => void) => (): void => {
    if (artworkId === null) return
    const notice = hiddenNotice(target, templateById(artworkId))
    if (notice === null) edit(artworkId)
    else showToast(notice, 'warning')
  }
  const updateArtwork = whenDrawn((id) => requestTemplateArtworkUpdate(id, rerender))
  // Area updates select with the capture editor, which only works over the world canvas.
  const updateArea: MenuEntry | null =
    surface.kind === 'world'
      ? {
          icon: 'fitScreen',
          label: 'Update an area',
          returnToCanvas: true,
          run: whenDrawn((id) => requestTemplateAreaUpdate(id, rerender)),
        }
      : null
  const rename: MenuEntry = {
    icon: 'rename',
    label: 'Rename',
    run: () => {
      startRenaming(target.key)
      rerender()
    },
  }
  const remove: MenuEntry = {
    icon: 'trash',
    label: 'Delete',
    danger: true,
    run: () => void deleteTreeRow(target, rerender),
  }
  const exportEntries: MenuEntry[] = [
    { icon: 'download', label: 'Export .wplace', run: () => void exportTemplate(target, 'wplace') },
    { icon: 'download', label: 'Export .png', run: () => void exportTemplate(target, 'png') },
  ]
  const showOnly = target.showOnly
  const showOnlyEntry: MenuEntry | null =
    showOnly === undefined
      ? null
      : {
          icon: 'eye',
          label: 'Show only this',
          run: () =>
            void showOnly().then((saved) => {
              if (!saved) showToast(`Could not change visibility for “${target.name}”.`, 'error')
              rerender()
            }),
        }
  const lifecycle = templateStateOf(target)
  const published = lifecycle?.published ?? false
  const alarm =
    target.server === null || lifecycle === null ? null : serverAlarmFor(target.server, lifecycle)
  const dismissGrief: MenuEntry | null =
    alarm === null || target.server === null
      ? null
      : {
          icon: 'check',
          label: 'Dismiss grief alert',
          run: () => {
            const server = target.server
            if (server === null) return
            void dismissTemplateAlarm(server, alarm.templateId, alarm.id).then((result) => {
              if (!result.ok) showToast(result.message, 'error')
              requestServerSync('manual', 'telemetry-alarms', server)
              rerender()
            })
          },
        }
  const folderTemplates = folderTemplatesFor(target)
  const folderPublished =
    folderTemplates !== null &&
    folderTemplates.length > 0 &&
    folderTemplates.every((template) => template.published)
  const folderPublication: MenuEntry | null =
    folderTemplates === null
      ? null
      : folderPublished
        ? {
            icon: 'eyeOff',
            label: 'Unpublish folder',
            run: () => void setServerFolderPublished(target, false, rerender),
          }
        : {
            icon: 'eye',
            label: 'Publish folder',
            run: () => void setServerFolderPublished(target, true, rerender),
          }
  const folderBackfill: MenuEntry | null =
    folderTemplates !== null && canBackfill(target)
      ? { icon: 'download', label: 'Backfill history', run: () => openBackfill(target) }
      : null
  const finished = lifecycle?.finished ?? false
  const frozen = lifecycle?.timelapseFrozen === true
  const markAs: MenuEntry = {
    icon: 'taskAlt',
    label: 'Mark as…',
    children: [
      {
        icon: 'flag',
        label: 'Finished',
        checked: finished,
        run: () => void patchServerTemplate(target, { finished: !finished }, rerender),
      },
      {
        icon: 'snowflake',
        label: 'Frozen',
        checked: frozen,
        run: () => void patchServerTemplate(target, { timelapseFrozen: !frozen }, rerender),
      },
    ],
  }
  const existingGroups: MenuGroups =
    // A template on a server, which is a different set of verbs from either a folder or a local
    // template: it can be moved between folders, published, and replaced with new artwork.
    target.templateId !== undefined
      ? target.server === null || !hasServerAdminToken(target.server)
        ? { organise: exportEntries }
        : {
            organise: [
              {
                icon: 'move',
                label: 'Move to folder',
                run: () => void moveServerTemplate(target, rerender),
              },
              ...exportEntries,
            ],
            publish: [
              published
                ? {
                    icon: 'eyeOff',
                    label: 'Unpublish',
                    run: () => void patchServerTemplate(target, { published: false }, rerender),
                  }
                : {
                    icon: 'eye',
                    label: 'Publish',
                    run: () => void patchServerTemplate(target, { published: true }, rerender),
                  },
              dismissGrief,
            ],
            state: [markAs],
            artwork: [
              {
                icon: 'uploadFile',
                label: 'Replace artwork',
                run: whenDrawn(() => void replaceServerArtwork(target, rerender)),
              },
              {
                icon: 'image',
                label: 'Replace from image',
                returnToCanvas: true,
                run: whenDrawn((id) => void replaceFromImage(target, id, rerender)),
              },
              { icon: 'reset', label: 'Use canvas artwork', run: updateArtwork },
              updateArea,
              canBackfill(target)
                ? {
                    icon: 'download',
                    label: 'Backfill history',
                    run: () => openBackfill(target),
                  }
                : null,
            ],
            edit: [rename],
            danger: [remove],
          }
      : templateId === null
        ? {
            organise: [
              {
                icon: 'createFolder',
                label: 'New folder',
                run: () => void createFolder(target, rerender),
              },
              {
                icon: 'uploadFile',
                label: 'Import template',
                returnToCanvas: true,
                run: () => void importTemplate(target, rerender),
              },
              {
                icon: 'image',
                label: 'Create from image',
                returnToCanvas: true,
                run: () => createFromImage(target, rerender),
              },
              surface.kind === 'world'
                ? {
                    icon: 'fitScreen',
                    label: 'Capture from canvas',
                    returnToCanvas: true,
                    run: () => captureTemplate(target, rerender),
                  }
                : null,
            ],
            publish: [folderPublication],
            artwork: [folderBackfill],
            edit: [rename],
            danger: [remove],
          }
        : {
            navigate: [
              {
                icon: 'search',
                label: 'Go to',
                returnToCanvas: true,
                run: () => goToLocalTemplate(templateId),
              },
              showOnlyEntry,
            ],
            organise: [
              {
                icon: 'move',
                label: 'Move',
                returnToCanvas: true,
                run: whenDrawn((id) => {
                  // `beginMove` refuses while another placement is running, while the template is
                  // mid-delete, and when it has gone. Without this the menu entry would do nothing
                  // at all, with no placement and no explanation.
                  if (!beginMove(id, rerender))
                    showToast(
                      'Finish the placement already in progress, then move this one.',
                      'warning',
                    )
                }),
              },
              {
                icon: 'uploadFile',
                label: 'Copy to a server',
                run: () => void copyToServer(templateId, rerender),
              },
              ...exportEntries,
            ],
            artwork: [
              { icon: 'reset', label: 'Use canvas artwork', run: updateArtwork },
              updateArea,
            ],
            edit: [rename],
            danger: [remove],
          }
  const claimed = hasOwnTemplateClaim(target)
  const groups: MenuGroups = {
    // Fly-to leads every template menu: on touch the menu is the only way to reach it.
    navigate: [
      lifecycle === null
        ? null
        : {
            icon: 'search',
            label: 'Go to',
            returnToCanvas: true,
            run: () => goToServerTemplate(lifecycle.bbox, surface),
          },
      showOnlyEntry,
    ],
    work:
      (target.templateId !== undefined || templateId !== null) && canClaimTemplate(target)
        ? [
            {
              icon: 'check',
              label: claimed ? 'Unfavourite' : 'Favourite',
              run: () => void claimTemplate(target, rerender, claimed),
            },
          ]
        : [],
    ...(target.server === null || target.server.isAdmin || target.templateId !== undefined
      ? existingGroups
      : {}),
  }
  showContextMenu({ rowKey: target.key, x: event.clientX, y: event.clientY }, groups, rerender)
}
