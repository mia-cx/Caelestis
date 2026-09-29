import { encodeIndexedPng } from '@caelestis/shared'
import type { ClaimCaptureAction } from '@caelestis/ui/elements'
import { stopClaimMode } from '../claim-editor.js'
import { warn } from '../debug.js'
import {
  captureRegion,
  type RegionCapture,
  type RegionSelection,
  templateFromCapture,
} from '../templates/capture-region.js'
import { addLocalTemplate, removeLocalTemplate } from '../templates/local-store.js'
import { reserveMove } from '../templates/move.js'
import { toast } from '../ui/toast.js'

export const captureFilename = (capture: RegionCapture): string =>
  `capture-${capture.originX}-${capture.originY}-${capture.width}x${capture.height}.png`

const download = async (capture: RegionCapture): Promise<void> => {
  const png = await encodeIndexedPng(capture.width, capture.height, capture.indices)
  const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }))
  const link = document.createElement('a')
  link.href = url
  link.download = captureFilename(capture)
  link.hidden = true
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const reason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')

/**
 * Snapshot the selection, then download it or open it as a new template in the placement flow.
 * Returns an error message for the editor to show, or null once the capture is done.
 */
export const captureSelection = async (
  selection: RegionSelection,
  action: ClaimCaptureAction,
  rerender: () => void,
): Promise<string | null> => {
  // Reserve first: a template can only open placement when nothing else is being placed.
  const reservation = action === 'template' ? reserveMove() : null
  if (action === 'template' && reservation === null)
    return 'Finish the current placement, then capture again.'
  try {
    const capture = await captureRegion(selection)
    if (action === 'download') {
      await download(capture)
      toast(`Downloaded ${captureFilename(capture)}.`)
      return null
    }
    const template = templateFromCapture(capture)
    await addLocalTemplate(template)
    rerender()
    // The editor's window listeners would swallow the placement pointer events.
    stopClaimMode()
    if (reservation === null || !reservation.start(template.id, rerender)) {
      await removeLocalTemplate(template.id)
      rerender()
      toast('Another placement started. Finish it, then capture again.', 'warning')
      return null
    }
    toast(`Captured ${template.width}x${template.height}. Move it, then click to place.`)
    return null
  } catch (error) {
    warn('install', 'could not capture region', String(error))
    return `Could not capture: ${reason(error)}.`
  } finally {
    reservation?.release()
  }
}
