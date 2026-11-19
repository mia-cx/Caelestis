import { encodeIndexedPng } from '@caelestis/shared'
import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { uploadTemplateVersion } from '../server-api.js'
import {
  hasServerAdminToken,
  isCurrentServerConnection,
  serverConnectionIdentity,
} from '../server-connections.js'
import { admittedManifest, readManifest } from '../server-manifests.js'
import { invalidateServerReads } from '../server-read-coalescer.js'
import { getState } from '../settings.js'
import { isCurrentTemplate, type PlacedTemplate, templateById } from '../templates/catalog.js'
import { replaceLocalArtwork } from '../templates/template-edits.js'
import { holdUpdating, templateBusy } from './template-busy.js'

/**
 * Save captured art as a new target version without submitting paint events. `capture` reads the
 * new target from committed art, or resolves to null to abandon the update. False when abandoned.
 */
export const updateArtwork = async (
  id: string,
  capture: (template: PlacedTemplate) => Promise<Uint8Array | null>,
): Promise<boolean> => {
  if (templateBusy(id, 'updating')) throw new Error('This template is already being updated.')
  const release = holdUpdating(id)
  try {
    const template = templateById(id)
    if (template === undefined)
      throw new Error('This template has not finished loading. Try again in a moment.')
    const surface = template.surface
    const server =
      template.origin === 'server'
        ? getState().servers.find((candidate) => candidate.url === template.server.url)
        : undefined
    const checkCurrent = (): void => {
      if (!isCurrentTemplate(template) || templateBusy(id, 'deleting'))
        throw new Error('That template changed during the update. Try again.')
      if (templateBusy(id, 'placing') || (template.source === 'image' && !template.everPlaced))
        throw new Error('Finish placing this template before updating it.')
      if (template.origin === 'local') return
      if (
        template.origin !== 'server' ||
        server === undefined ||
        !hasServerAdminToken(server) ||
        !isCurrentServerConnection(server)
      )
        throw new Error('Admin access to this server is required.')
      const current = admittedManifest(server, surface)?.templates.find(
        (candidate) => candidate.id === template.serverTemplateId,
      )
      if (current === undefined || current.version !== template.version)
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
    if (template.origin !== 'server') throw new Error('The server template is no longer available.')
    const result = await uploadTemplateVersion(server, template.serverTemplateId, {
      originX: template.originX,
      originY: template.originY,
      name: template.name,
      png,
    })
    if (result.ok || result.ambiguous === true) {
      invalidateServerReads(serverConnectionIdentity(server))
      // Upload uncertainty is connection-wide and cleared by an admitted world manifest.
      if (surface.kind === 'world' || !result.ok) await readManifest(server)
      if (surface.kind !== 'world') await refreshAllianceManifest(server, surface)
    }
    if (!result.ok) throw new Error(result.message)
    return true
  } finally {
    release()
  }
}
