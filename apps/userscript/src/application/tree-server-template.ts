import {
  encodeIndexedPng,
  sameTemplateSurface,
  templatesInFolderSubtree,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { runWhileBusy } from '../concurrency.js'
import { listServerNodes, patchTemplate, uploadTemplateVersion } from '../server-api.js'
import { isCurrentServerConnection, serverByUrl, serverLabel } from '../server-connections.js'
import type { ServerTemplate } from '../server-manifest.js'
import {
  isCurrentTemplate,
  localTemplates,
  templateAsPng,
  templateById,
} from '../templates/local-store.js'
import { toast } from '../ui/toast.js'
import type { TreeTarget } from '../ui/tree.js'
import { claimFolderPublication, setFolderTemplatesPublished } from './folder-publication.js'
import { plural } from './plural.js'
import { serverDestinations } from './server-destinations.js'
import { transferAuthoring } from './template-authoring.js'
import { busyRefusal, templateBusy } from './template-busy.js'
import { openTemplateStudio } from './template-studio.js'
import {
  closeOperation,
  isOperationOpen,
  MAX_DESTINATIONS,
  showOperation,
  updateOperation,
} from './tree-presentation.js'
import {
  refreshCurrentNodes,
  refreshEditedSurface,
  retryOptimisticMutation,
  serverNodesFailure,
} from './tree-server.js'
import { rowsForSurface, serverTemplateAt } from './tree-server-state.js'
import { surfaceOf } from './tree-target.js'

/** The template state from the same admitted snapshot that drew this row. */
export const templateStateOf = (target: TreeTarget): ServerTemplate | null =>
  target.server !== null && target.templateId !== undefined
    ? serverTemplateAt(target.server.url, target.templateId, surfaceOf(target))
    : null

/** Every template anywhere below a server folder row, or null for any other row. */
export const folderTemplatesFor = (target: TreeTarget): readonly ServerTemplate[] | null => {
  if (target.server === null || target.nodeId === null || target.templateId !== undefined)
    return null
  const rows = rowsForSurface(target.server, surfaceOf(target))
  return rows === undefined
    ? null
    : templatesInFolderSubtree(rows.nodes, rows.templates, target.nodeId)
}

/**
 * Move a published template into another folder on the same server.
 *
 * The context-menu alternative to dragging: useful when the destination is off-screen or a precise
 * pointer gesture is awkward.
 */
export const moveServerTemplate = async (
  target: TreeTarget,
  rerender: () => void,
): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const surface = surfaceOf(target)
  const listed = await listServerNodes(server, undefined, surface)
  if (listed.status !== 'ok') {
    toast(serverNodesFailure(listed), 'error')
    return
  }
  const destinations = serverDestinations(listed.nodes).filter(
    (destination) => destination.nodeId !== target.nodeId,
  )
  if (destinations.length === 0) {
    toast('There is nowhere else to put it.', 'warning')
    return
  }

  let id = ''
  id = showOperation(
    {
      label: `Move “${target.name}” to:`,
      options: destinations.slice(0, MAX_DESTINATIONS).map((destination) => ({
        value: destination.nodeId ?? '',
        label: destination.label,
      })),
      ...(destinations.length > MAX_DESTINATIONS
        ? { note: `Showing the first ${MAX_DESTINATIONS} of ${destinations.length} folders.` }
        : {}),
      confirmLabel: 'Move',
    },
    rerender,
    {
      onConfirm: (value) => {
        updateOperation(id, { pending: true, cancellable: false })
        void runWhileBusy(`template:move:${templateId}`, async () => {
          const result = await patchTemplate(server, templateId, {
            nodeId: value === '' ? null : value,
          })
          closeOperation(id)
          if (!result.ok) toast(result.message, 'error')
          void refreshEditedSurface(server, surface, rerender)
        })
      },
    },
  )
}

/**
 * Replace a published template's artwork with a local template's.
 *
 * Deliberately sourced from Local rather than from a file picker: a raw image has no placement, and
 * the origin is half of what a version *is*. Getting a template positioned locally and then pushing
 * it up is the same path Copy to a server already establishes — this is that path for artwork that
 * already exists on the server.
 */
export const replaceServerArtwork = async (
  target: TreeTarget,
  rerender: () => void,
): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  // A new version has to be the same size as the one it replaces; the server refuses anything else
  // and there is nothing the user can do about it after the fact. Offering every Local template
  // meant most choices were an unavoidable 409 presented as a valid option.
  const surface = surfaceOf(target)
  const current = serverTemplateAt(server.url, templateId, surface)
  const span = (min: number, max: number) => (max >= min ? max - min : WORLD_PIXELS - min + max)
  const wanted =
    current === null
      ? null
      : {
          width: span(current.bbox.minX, current.bbox.maxX),
          height: current.bbox.maxY - current.bbox.minY,
        }
  const localSources = localTemplates().filter((candidate) =>
    sameTemplateSurface(candidate.surface ?? WORLD_TEMPLATE_SURFACE, surface),
  )
  const sources =
    wanted === null
      ? localSources
      : localSources.filter(
          (candidate) => candidate.width === wanted.width && candidate.height === wanted.height,
        )
  if (sources.length === 0) {
    toast(
      wanted === null
        ? 'Import the new artwork into Local first, and place it where it belongs.'
        : `Replacing this needs a Local template that is exactly ${wanted.width}x${wanted.height}.`,
      'warning',
    )
    return
  }

  let cancelled = false
  let id = ''
  id = showOperation(
    {
      label: `Replace “${target.name}” with:`,
      options: sources.map((candidate) => ({ value: candidate.id, label: candidate.name })),
      note: 'Its position travels with it — the server re-slices from where it sits now.',
      confirmLabel: 'Replace',
    },
    rerender,
    {
      onCancel: () => {
        cancelled = true
      },
      onConfirm: (value) => {
        // Read fresh rather than using the list captured when the dialog opened: it has been on screen
        // while the map was in use, and the template may have been moved, renamed or redrawn since.
        const source = templateById(value)
        if (source === undefined) {
          toast('That template is no longer here.', 'error')
          closeOperation(id)
          return
        }
        const busy = busyRefusal(source, 'replacing from it')
        if (busy !== null) {
          toast(busy, 'warning')
          return
        }
        updateOperation(id, { label: 'Encoding…', pending: true })
        void runWhileBusy(`template:replace:${templateId}`, async () => {
          const png = await templateAsPng(source)
          if (png === null) {
            toast('Could not encode that template.', 'error')
            closeOperation(id)
            return
          }
          const carried = await transferAuthoring(source)
          if ('message' in carried) {
            toast(carried.message, 'error')
            closeOperation(id)
            return
          }
          if (!isCurrentTemplate(source) || templateBusy(source.id, 'placing')) {
            toast(`“${source.name}” changed while it was being encoded — try again.`, 'warning')
            return
          }
          if (cancelled || !isOperationOpen(id)) return
          if (!isCurrentServerConnection(server)) {
            toast('That server was disconnected or replaced.', 'warning')
            closeOperation(id)
            return
          }
          updateOperation(id, {
            label: `Uploading ${Math.round(png.size / 1024)} KB…`,
            cancellable: false,
          })
          const result = await uploadTemplateVersion(server, templateId, {
            originX: source.originX,
            originY: source.originY,
            name: source.name,
            png,
            authoring: carried.authoring,
          })
          closeOperation(id)
          if (result.ok) toast(`Replaced the artwork for “${target.name}”.`)
          else toast(result.message, 'error')
          const reconciliation = refreshEditedSurface(server, surface, rerender)
          if (!result.ok && result.ambiguous === true) await reconciliation
          else void reconciliation
        })
      },
    },
  )
}

/**
 * Make a server template's next version in the template studio. The version keeps the template's
 * size and starts from its current source image when the server has one.
 */
export const replaceFromImage = async (
  target: TreeTarget,
  installedId: string,
  rerender: () => void,
): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const surface = surfaceOf(target)
  const current = serverTemplateAt(server.url, templateId, surface)
  const installed = templateById(installedId)
  if (current === null || installed === undefined) {
    toast('This template has not finished loading. Try again in a moment.', 'warning')
    return
  }
  const carried = await transferAuthoring(installed)
  const authoring = 'authoring' in carried ? carried.authoring : null
  const opened = openTemplateStudio(
    {
      kind: 'replace',
      name: target.name,
      server: serverLabel(server),
      surface,
      width: installed.width,
      height: installed.height,
      origin: { x: installed.originX, y: installed.originY },
      save: async (template) => {
        if (!isCurrentServerConnection(server)) {
          toast('That server was disconnected or replaced.', 'warning')
          return false
        }
        const png = new Blob(
          [
            Uint8Array.from(
              await encodeIndexedPng(template.width, template.height, template.indices),
            ),
          ],
          { type: 'image/png' },
        )
        const result = await uploadTemplateVersion(server, templateId, {
          originX: template.originX,
          originY: template.originY,
          name: target.name,
          png,
          authoring: template.authoring ?? null,
        })
        const reconciliation = refreshEditedSurface(server, surface, rerender)
        if (!result.ok && result.ambiguous === true) await reconciliation
        else void reconciliation
        if (!result.ok) {
          toast(result.message, 'error')
          return false
        }
        toast(`Replaced the artwork for “${target.name}”.`)
        return true
      },
    },
    authoring === null ? undefined : { image: authoring.source, name: target.name },
  )
  if (!opened) toast('Finish the current placement or template, then try again.', 'warning')
}

/**
 * Change a published template's state: published, which is the difference between everyone seeing
 * it and only admins, or its finished and frozen lifecycle flags.
 */
export const patchServerTemplate = async (
  target: TreeTarget,
  patch: {
    readonly published?: boolean
    readonly finished?: boolean
    readonly timelapseFrozen?: boolean
  },
  rerender: () => void,
): Promise<void> => {
  const { server, templateId } = target
  if (server === null || templateId === undefined) return
  const result = await patchTemplate(server, templateId, patch)
  if (!result.ok) toast(result.message, 'error')
  await refreshEditedSurface(server, surfaceOf(target), rerender)
}

/** Publish or unpublish every template hanging anywhere below one server folder. */
export const setServerFolderPublished = async (
  target: TreeTarget,
  published: boolean,
  rerender: () => void,
): Promise<void> => {
  const { server, nodeId } = target
  if (server === null || nodeId === null || target.templateId !== undefined) return
  const surface = surfaceOf(target)
  const releasePublication = claimFolderPublication(server.url)
  if (releasePublication === null) {
    toast('Another folder on that server is already changing publication state.', 'warning')
    return
  }
  try {
    if (surface.kind === 'world') {
      const refreshed = await refreshCurrentNodes(server, rerender, true)
      if (refreshed?.status !== 'admitted') {
        toast(
          refreshed?.message ?? 'That server was disconnected before the folder could change.',
          'error',
        )
        return
      }
    } else {
      await refreshAllianceManifest(server, surface)
      rerender()
    }
    const current = serverByUrl(server.url)
    if (current === undefined) {
      toast('That server was disconnected before the folder could change.', 'error')
      return
    }
    const rows = rowsForSurface(current, surface)
    const templates =
      rows === undefined ? null : templatesInFolderSubtree(rows.nodes, rows.templates, nodeId)
    if (templates === null) {
      toast(`Could not read what is inside “${target.name}”.`, 'error')
      return
    }
    const wanted = templates.filter((template) => template.published !== published).length
    if (wanted === 0) {
      toast(
        templates.length === 0
          ? `There are no templates in “${target.name}”.`
          : `Everything in “${target.name}” is already ${published ? 'published' : 'unpublished'}.`,
      )
      return
    }

    toast(`${published ? 'Publishing' : 'Unpublishing'} ${plural(wanted, 'template')}…`)
    const result = await setFolderTemplatesPublished(templates, published, (template) =>
      retryOptimisticMutation(async () => {
        if (!isCurrentServerConnection(current))
          return {
            ok: false,
            message: 'That server was disconnected or replaced.',
            stop: true,
          }
        return await patchTemplate(current, template.id, { published })
      }),
    )
    if (isCurrentServerConnection(current)) await refreshEditedSurface(current, surface, rerender)
    else rerender()
    if (result.failures.length === 0) {
      toast(
        `${published ? 'Published' : 'Unpublished'} ${plural(result.succeeded, 'template')} in “${target.name}”.`,
      )
      return
    }
    toast(
      `${result.succeeded} of ${result.requested} templates changed; ${result.failures.length} could not be ${published ? 'published' : 'unpublished'}.`,
      'error',
    )
  } finally {
    releasePublication()
  }
}
