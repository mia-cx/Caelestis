import { currentSurface } from '../alliance-surface.js'
import { templateBusy } from '../application/template-busy.js'
import { updateArtwork } from '../application/update-template-artwork.js'
import { startCaptureMode } from '../claim-editor.js'
import { errorText } from '../error-text.js'
import { isCurrentTemplate, templateById } from '../templates/catalog.js'
import { captureCurrentArtwork, captureTemplateArea } from '../templates/current-artwork.js'
import { templatePixels } from '../templates/residency.js'
import { deepActiveElement } from './focus.js'
import { requestConfirmation, showToast } from './notification-host.js'

const confirming = new Set<string>()

/** Confirm the target change before either menu starts capturing or saving artwork. */
export const requestTemplateArtworkUpdate = (id: string, rerender: () => void): void => {
  if (confirming.has(id) || templateBusy(id, 'updating')) return
  const template = templateById(id)
  if (template === undefined) return
  const trigger = deepActiveElement()
  confirming.add(id)
  void (async () => {
    const confirmed = await requestConfirmation({
      title: `Use canvas artwork for “${template.name}”?`,
      body:
        'Merge committed canvas artwork with the current template. Current mismatches will be treated as correct in the new canonical version. ' +
        (template.origin !== 'local'
          ? 'This changes the target for everyone using this server template. '
          : '') +
        'You cannot currently revert to a previous version.',
      note: '',
      confirmLabel: 'Use canvas artwork',
      restoreFocusTo: trigger,
    })
    if (!confirmed) return
    if (!isCurrentTemplate(template))
      throw new Error('That template changed while confirmation was open. Try again.')
    const update = updateArtwork(id, captureCurrentArtwork)
    rerender()
    await update
    showToast('Saved a new template version from the committed artwork.')
  })()
    .catch((error: unknown) => showToast(errorText(error), 'error'))
    .finally(() => {
      confirming.delete(id)
      rerender()
    })
}

/**
 * Select parts of a world template on the map, then replace only those with committed art. The
 * confirmation names how many pixels change; declining keeps the selection for another try.
 */
export const requestTemplateAreaUpdate = (id: string, rerender: () => void): void => {
  if (currentSurface().kind !== 'world') {
    showToast('Area updates work on the world canvas. Leave the alliance canvas first.', 'warning')
    return
  }
  const started = startCaptureMode({
    purpose: 'update',
    capture: async (selection, _action, signal) => {
      let pixels = ''
      const update = updateArtwork(id, async (template) => {
        const current = await templatePixels(template)
        const indices = await captureTemplateArea(
          { ...template, indices: current },
          selection,
          signal,
        )
        signal.throwIfAborted()
        const changed = indices.reduce(
          (count, index, at) => count + Number(index !== current[at]),
          0,
        )
        if (changed === 0)
          throw new Error('No canvas art in this selection differs from the template.')
        pixels = `${changed.toLocaleString()} ${changed === 1 ? 'pixel' : 'pixels'}`
        const trigger = deepActiveElement()
        const confirmed = await requestConfirmation({
          title: `Update ${pixels} of “${template.name}”?`,
          body:
            'Committed canvas artwork replaces the template inside your selection. ' +
            (template.origin !== 'local'
              ? 'This changes the target for everyone using this server template. '
              : '') +
            'You cannot currently revert to a previous version.',
          note: '',
          confirmLabel: 'Update template',
          restoreFocusTo: trigger,
        })
        signal.throwIfAborted()
        return confirmed ? indices : null
      })
      rerender()
      try {
        if (!(await update)) return 'Template unchanged.'
      } finally {
        rerender()
      }
      showToast(`Updated ${pixels} from the canvas.`)
      return null
    },
  })
  if (!started) showToast('Leave claim mode, then update the template.', 'warning')
}
