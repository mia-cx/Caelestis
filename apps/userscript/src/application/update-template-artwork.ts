import { encodeIndexedPng, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { allianceManifestFor, refreshAllianceManifest } from '../alliance-server-sync.js'
import { activeAllianceSurface } from '../alliance-surface.js'
import { startCaptureMode } from '../claim-editor.js'
import { invalidateServerReads } from '../server-read-coalescer.js'
import {
  admittedServerContentsFor,
  getState,
  hasServerAdminToken,
  isCurrentServerConnection,
  listServerContents,
  serverConnectionIdentity,
  uploadTemplateVersion,
} from '../state.js'
import { captureCurrentArtwork, captureTemplateArea } from '../templates/current-artwork.js'
import {
  isCurrentTemplate,
  isDeletingLocal,
  isServerTemplate,
  type PlacedTemplate,
  replaceLocalArtwork,
  templateById,
} from '../templates/local-store.js'
import { movingId } from '../templates/move.js'
import { confirmDestructive } from '../ui/confirm.js'
import { toast } from '../ui/toast.js'

const pending = new Set<string>()
const confirming = new Set<string>()

/** Whether either template menu is already capturing or saving this template. */
export const isUpdatingTemplateArtwork = (id: string): boolean => pending.has(id)

/**
 * Save captured art as a new target version without submitting paint events. `capture` reads the
 * new target from committed art, or resolves to null to abandon the update. False when abandoned.
 */
const updateArtwork = async (
  id: string,
  capture: (template: PlacedTemplate) => Promise<Uint8Array | null>,
): Promise<boolean> => {
  if (pending.has(id)) throw new Error('This template is already being updated.')
  pending.add(id)
  try {
    const template = templateById(id)
    if (template === undefined)
      throw new Error('This template has not finished loading. Try again in a moment.')
    const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
    const server = isServerTemplate(template)
      ? getState().servers.find((candidate) => candidate.url === template.serverUrl)
      : undefined
    const checkCurrent = (): void => {
      if (!isCurrentTemplate(template) || isDeletingLocal(id))
        throw new Error('That template changed during the update. Try again.')
      if (movingId() === id || (template.source === 'image' && !template.everPlaced))
        throw new Error('Finish placing this template before updating it.')
      if (!isServerTemplate(template)) return
      if (
        server === undefined ||
        !hasServerAdminToken(server) ||
        !isCurrentServerConnection(server)
      )
        throw new Error('Admin access to this server is required.')
      const manifest =
        surface.kind === 'world'
          ? admittedServerContentsFor(server)
          : allianceManifestFor(server, surface)
      const current = manifest?.templates.find(
        (candidate) => candidate.id === template.serverTemplateId,
      )
      if (current === undefined || current.version !== template.serverVersion)
        throw new Error(
          'The current template version has not finished loading. Try again in a moment.',
        )
    }
    checkCurrent()
    const indices = await capture(template)
    if (indices === null) return false
    checkCurrent()
    if (server === undefined) {
      await replaceLocalArtwork(template, indices)
      return true
    }
    const png = new Blob(
      [Uint8Array.from(await encodeIndexedPng(template.width, template.height, indices))],
      { type: 'image/png' },
    )
    checkCurrent()
    const templateId = template.serverTemplateId
    if (templateId === undefined) throw new Error('The server template is no longer available.')
    const result = await uploadTemplateVersion(server, templateId, {
      originX: template.originX,
      originY: template.originY,
      name: template.name,
      png,
    })
    if (result.ok || result.ambiguous === true) {
      invalidateServerReads(serverConnectionIdentity(server))
      // Upload uncertainty is connection-wide and cleared by an admitted world manifest.
      if (surface.kind === 'world' || !result.ok) await listServerContents(server)
      if (surface.kind !== 'world') await refreshAllianceManifest(server, surface)
    }
    if (!result.ok) throw new Error(result.message)
    return true
  } finally {
    pending.delete(id)
  }
}

/** Save committed Wplace art over the whole template as a new target version. */
export const updateTemplateArtwork = (id: string): Promise<boolean> =>
  updateArtwork(id, captureCurrentArtwork)

/** Confirm the target change before either menu starts capturing or saving artwork. */
export const requestTemplateArtworkUpdate = (id: string, rerender: () => void): void => {
  if (confirming.has(id) || pending.has(id)) return
  const template = templateById(id)
  if (template === undefined) return
  let trigger = document.activeElement
  while (trigger?.shadowRoot?.activeElement) trigger = trigger.shadowRoot.activeElement
  confirming.add(id)
  void (async () => {
    const confirmed = await confirmDestructive({
      title: `Use canvas artwork for “${template.name}”?`,
      body:
        'Merge committed canvas artwork with the current template. Current mismatches will be treated as correct in the new canonical version. ' +
        (isServerTemplate(template)
          ? 'This changes the target for everyone using this server template. '
          : '') +
        'You cannot currently revert to a previous version.',
      note: '',
      confirmLabel: 'Use canvas artwork',
      restoreFocusTo: trigger instanceof HTMLElement ? trigger : null,
    })
    if (!confirmed) return
    if (!isCurrentTemplate(template))
      throw new Error('That template changed while confirmation was open. Try again.')
    const update = updateTemplateArtwork(id)
    rerender()
    await update
    toast('Saved a new template version from the committed artwork.')
  })()
    .catch((error: unknown) =>
      toast(error instanceof Error ? error.message : String(error), 'error'),
    )
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
  if (activeAllianceSurface() !== null) {
    toast('Area updates work on the world canvas. Leave the alliance canvas first.', 'warning')
    return
  }
  const started = startCaptureMode({
    purpose: 'update',
    capture: async (selection, _action, signal) => {
      let pixels = ''
      const update = updateArtwork(id, async (template) => {
        const indices = await captureTemplateArea(template, selection, signal)
        signal.throwIfAborted()
        const changed = indices.reduce(
          (count, index, at) => count + Number(index !== template.indices[at]),
          0,
        )
        if (changed === 0)
          throw new Error('No canvas art in this selection differs from the template.')
        pixels = `${changed.toLocaleString()} ${changed === 1 ? 'pixel' : 'pixels'}`
        let trigger = document.activeElement
        while (trigger?.shadowRoot?.activeElement) trigger = trigger.shadowRoot.activeElement
        const confirmed = await confirmDestructive({
          title: `Update ${pixels} of “${template.name}”?`,
          body:
            'Committed canvas artwork replaces the template inside your selection. ' +
            (isServerTemplate(template)
              ? 'This changes the target for everyone using this server template. '
              : '') +
            'You cannot currently revert to a previous version.',
          note: '',
          confirmLabel: 'Update template',
          restoreFocusTo: trigger instanceof HTMLElement ? trigger : null,
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
      toast(`Updated ${pixels} from the canvas.`)
      return null
    },
  })
  if (!started) toast('Leave claim mode, then update the template.', 'warning')
}
