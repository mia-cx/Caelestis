import {
  encodeIndexedPng,
  type TemplateSurface,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { activeAllianceSurface, allianceSurfaceCentre } from '../alliance-surface.js'
import { startCaptureMode } from '../claim-editor.js'
import { viewportCentre } from '../map-view.js'
import { captureSelectedArtwork } from '../templates/current-artwork.js'
import { type ImportedTemplate, importFile, newTemplateId } from '../templates/import.js'
import {
  addLocalTemplate,
  removeLocalTemplate,
  setTemplateFolder,
} from '../templates/local-store.js'
import { type MoveReservation, reserveMove } from '../templates/move.js'
import { centreOf, navigateTo } from '../templates/navigate.js'
import { localFolderIdOf } from '../tree-keys.js'
import { toast } from '../ui/toast.js'
import type { TreeTarget } from '../ui/tree.js'
import { importTemplatesToServer } from './import-to-server.js'
import { openTemplateStudio } from './template-studio.js'
import { refreshEditedSurface } from './tree-server.js'
import { hiddenNotice } from './tree-target.js'

/** Save `file` as `filename` through the browser's own download. */
export const download = (file: Blob, filename: string): void => {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoking in the same task can cancel the download before the browser has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const importCentre = (surface: TemplateSurface): { x: number; y: number } =>
  surface.kind === 'world' ? (viewportCentre() ?? { x: 0, y: 0 }) : allianceSurfaceCentre(surface)

export const importTemplate = async (
  target: TreeTarget,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<void> => {
  const notice = hiddenNotice(target)
  if (notice !== null) {
    toast(notice, 'warning')
    return
  }
  const picker = document.createElement('input')
  picker.type = 'file'
  // iOS disables custom extensions such as .wplace when an accept filter is present.
  if (surface.kind !== 'world') picker.accept = 'image/png,image/*'
  picker.addEventListener('change', () => {
    const file = picker.files?.[0]
    if (file !== undefined)
      void importTemplateFile(file, target, rerender, surface, importCentre(surface))
  })
  picker.style.display = 'none'
  document.body.appendChild(picker)
  picker.click()
  // File inputs fire no cancel event on every browser, so a dismissed picker is reaped by time.
  setTimeout(() => picker.remove(), 60_000)
}

/**
 * Open the template studio to make a new template in a tree row, from `image` or from whatever
 * image the author brings to it.
 */
export const createFromImage = (
  target: TreeTarget,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
  image?: { readonly image: Blob; readonly name: string },
): void => {
  const notice = hiddenNotice(target)
  if (notice !== null) {
    toast(notice, 'warning')
    return
  }
  const opened = openTemplateStudio(
    {
      kind: 'create',
      destination: target.name,
      surface,
      save: (template) =>
        importTemplateData([template], target, rerender, surface, null, undefined, true),
    },
    image,
  )
  if (!opened) toast('Finish the current placement or template, then try again.', 'warning')
}

/** Template files carry their own placement; anything else is an image for the studio. */
const isTemplateFile = (file: File): boolean =>
  /\.(wplace|json)$/i.test(file.name) || file.type === 'application/json'

/** Import one file into a tree row. Files that carry a placement go where they belong. */
const importTemplateFile = async (
  file: File,
  target: TreeTarget,
  rerender: () => void,
  surface: TemplateSurface,
  centre: { readonly x: number; readonly y: number },
): Promise<boolean> => {
  if (!isTemplateFile(file)) {
    createFromImage(target, rerender, surface, { image: file, name: file.name })
    return true
  }
  try {
    toast(`Reading ${file.name}…`)
    const imported = await importFile(file, centre)
    if (imported.length === 0) {
      toast('Nothing importable in that file.', 'error')
      return false
    }
    return await importTemplateData(imported, target, rerender, surface, null)
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')
    toast(`Could not import “${file.name}”: ${reason}.`, 'error')
    return false
  }
}

/**
 * Admit decoded files or captured indices through the same destination and placement flow.
 * `placed` images were positioned in the template studio, so no placement follows.
 */
const importTemplateData = async (
  imported: readonly ImportedTemplate[],
  target: TreeTarget,
  rerender: () => void,
  surface: TemplateSurface,
  reservation: MoveReservation | null,
  signal?: AbortSignal,
  placed = false,
): Promise<boolean> => {
  const first = imported[0]
  if (first === undefined) {
    reservation?.release()
    return false
  }
  if (target.server !== null) {
    return await importTemplatesToServer(
      imported,
      target.server,
      target.nodeId ?? null,
      reservation,
      rerender,
      (server, render) => refreshEditedSurface(server, surface, render),
      surface,
      signal,
      placed,
    )
  }
  // Straight into whichever Local folder was clicked. Importing from a folder's own button
  // and then finding the result at the top level would make the button a lie.
  const folderId = localFolderIdOf(target.key)
  // Each record stands or falls on its own. Rolling the whole file back on one failure meant
  // importing two templates with one slot left admitted the first, hit the cap on the second,
  // and then deleted the first as well — a success thrown away to tidy up after a failure
  // that had nothing to do with it.
  const admitted: string[] = []
  const failed: string[] = []
  try {
    for (const template of imported) {
      signal?.throwIfAborted()
      try {
        await addLocalTemplate(template, surface, placed)
        admitted.push(template.id)
        if (folderId !== null && !(await setTemplateFolder(template.id, folderId)))
          failed.push(`${template.name} was imported, but not into that folder`)
      } catch (error) {
        failed.push(`${template.name}: ${String(error)}`)
      }
    }
    signal?.throwIfAborted()
    rerender()
    if (failed.length > 0) toast(failed.join('. '), 'error')
    if (!admitted.includes(first.id)) return false

    if (placed) {
      toast(`Created ${first.name} — ${first.width}x${first.height}`)
      return true
    }
    const moved = first.moved
    toast(
      `Imported ${first.name} — ${first.width}x${first.height}` +
        (moved > 0 ? `, ${moved.toLocaleString()} pixels quantised` : ''),
    )
    if (first.source === 'image') {
      signal?.throwIfAborted()
      // The reservation spans persistence, so another placement cannot strand this image in
      // volatile state between admission and `beginMove`.
      if (reservation === null || !reservation.start(first.id, rerender)) {
        for (const template of imported) await removeLocalTemplate(template.id)
        rerender()
        toast('Another placement started. Finish it, then import this image again.', 'warning')
        return false
      }
    } else {
      // It already knows where it belongs, so go and look at it — centred on the template and
      // zoomed to fit it, in-game. Changing the URL would reload and throw the import away.
      if (surface.kind === 'world') navigateTo(centreOf(first))
    }
    return true
  } catch (error) {
    if (signal?.aborted) {
      for (const id of admitted) await removeLocalTemplate(id)
    }
    rerender()
    throw error
  } finally {
    reservation?.release()
  }
}

/**
 * Capture committed world art into a new template. The claim editor's tools select the art; the
 * capture downloads as a PNG, or imports into `target` as Import template would, with placement
 * starting over the source so it can be dragged onto the damaged copy.
 */
export const captureTemplate = (target: TreeTarget, rerender: () => void): void => {
  const notice = hiddenNotice(target)
  if (notice !== null) {
    toast(notice, 'warning')
    return
  }
  if (activeAllianceSurface() !== null) {
    toast('Capture works on the world canvas. Leave the alliance canvas first.', 'warning')
    return
  }
  const started = startCaptureMode({
    purpose: 'capture',
    capture: async (selection, action, signal) => {
      signal.throwIfAborted()
      const reservation = action === 'template' ? reserveMove() : null
      if (action === 'template' && reservation === null)
        return 'Finish the current placement, then try again.'
      try {
        const indices = await captureSelectedArtwork(selection, signal)
        signal.throwIfAborted()
        const opaque = indices.reduce(
          (count, index) => count + Number(index !== TRANSPARENT_INDEX),
          0,
        )
        if (opaque === 0) return 'There is no painted art in this selection.'
        const { x, y, w, h } = selection.rect
        // Blue Marble's coordinates: tile, then pixel within it.
        const name = `Capture ${Math.floor(x / TILE_SIZE)}-${Math.floor(y / TILE_SIZE)}-${x % TILE_SIZE}-${y % TILE_SIZE}`
        if (action === 'download') {
          const png = new Blob([Uint8Array.from(await encodeIndexedPng(w, h, indices))], {
            type: 'image/png',
          })
          signal.throwIfAborted()
          download(png, `${name}.png`)
          toast(`Downloaded ${name}.png.`)
          return null
        }
        const template: ImportedTemplate = {
          id: newTemplateId(),
          name,
          source: 'image',
          originX: x,
          originY: y,
          width: w,
          height: h,
          indices,
          moved: 0,
          opaque,
        }
        const started = await importTemplateData(
          [template],
          target,
          rerender,
          WORLD_TEMPLATE_SURFACE,
          reservation,
          signal,
        )
        signal.throwIfAborted()
        return started ? null : 'Could not add the template. Try again.'
      } finally {
        reservation?.release()
      }
    },
  })
  if (!started) toast('Leave claim mode, then capture.', 'warning')
}
