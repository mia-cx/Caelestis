import { type ServerAsset, type ServerAssetKind, serverAssetPath } from '@caelestis/shared'
import type { ServerDetailsFields } from '@caelestis/ui/elements'
import {
  type ConnectedServer,
  deleteServerAsset,
  getState,
  isCurrentServerConnection,
  type ServerDetailsPatch,
  serverEndpoint,
  updateServerDetails,
  uploadServerAsset,
} from '../state.js'
import { openModalHost } from './modal-host.js'

const assetUrl = (
  server: ConnectedServer,
  kind: ServerAssetKind,
  asset: ServerAsset | undefined,
) => (asset === undefined ? null : serverEndpoint(server.url, serverAssetPath(kind, asset)))

/** What the dialog shows: the server's current public presentation, as this browser last read it. */
const fieldsFor = (server: ConnectedServer): ServerDetailsFields => ({
  name: server.info?.name ?? '',
  description: server.info?.description ?? '',
  discordInviteUrl: server.info?.discordInviteUrl ?? '',
  homeCopy: server.info?.homeCopy ?? '',
  logoText: server.info?.logoText ?? '',
})

/**
 * Only what changed goes on the wire, so an edit to the description cannot race a rename another
 * admin made in the meantime. An emptied field becomes null, which clears the override.
 */
const patchBetween = (
  before: ServerDetailsFields,
  after: ServerDetailsFields,
): ServerDetailsPatch => ({
  ...(after.name !== before.name ? { name: after.name } : {}),
  ...(after.description !== before.description
    ? { description: after.description === '' ? null : after.description }
    : {}),
  ...(after.discordInviteUrl !== before.discordInviteUrl
    ? { discordInviteUrl: after.discordInviteUrl === '' ? null : after.discordInviteUrl }
    : {}),
  ...(after.homeCopy !== before.homeCopy
    ? { homeCopy: after.homeCopy === '' ? null : after.homeCopy }
    : {}),
  ...(after.logoText !== before.logoText
    ? { logoText: after.logoText === '' ? null : after.logoText }
    : {}),
})

/** Open the public presentation editor for one connected server. Admin only; the tree gates it. */
export const openServerDetails = (server: ConnectedServer, rerender: () => void): void => {
  const current = (): ConnectedServer =>
    getState().servers.find((candidate) => candidate.url === server.url) ?? server
  const reseed = (notice: string): void => {
    const latest = current()
    dialog.update({
      ...fieldsFor(latest),
      owner: `${latest.info?.name ?? latest.url} · Server`,
      logoImageUrl: assetUrl(latest, 'logo', latest.info?.logoImage),
      previewImageUrl: assetUrl(latest, 'preview', latest.info?.previewImage),
      notice,
      error: undefined,
      revision: dialog.model.revision + 1,
    })
  }
  const failure = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error)
    return navigator.onLine === false
      ? 'You are offline. Reconnect and try again.'
      : /failed to fetch|network|timed out/i.test(message)
        ? 'Could not reach the server. Check your connection and try again.'
        : message
  }
  const run = async (
    work: () => Promise<{ ok: true } | { ok: false; message: string }>,
    done: string,
  ) => {
    if (dialog.model.busy) return
    dialog.update({ busy: true, error: undefined, notice: undefined })
    try {
      if (!isCurrentServerConnection(server))
        throw new Error('The server connection changed. Close and reopen server details.')
      const result = await work()
      if (!result.ok) throw new Error(result.message)
      reseed(done)
    } catch (error) {
      dialog.update({ error: failure(error) })
    } finally {
      dialog.update({ busy: false })
      rerender()
    }
  }
  const dialog = openModalHost(
    'caelestis-server-details',
    {
      owner: `${server.info?.name ?? server.url} · Server`,
      ...fieldsFor(server),
      logoImageUrl: assetUrl(server, 'logo', server.info?.logoImage),
      previewImageUrl: assetUrl(server, 'preview', server.info?.previewImage),
      busy: false,
      revision: 0,
    },
    {
      onIntent: (intent) => {
        switch (intent.type) {
          case 'save': {
            // Diff against what the dialog showed, not against global state: a refresh that landed
            // while the dialog was open must not make untouched fields look edited and overwrite
            // newer values.
            const patch = patchBetween(dialog.model, intent.fields)
            if (Object.keys(patch).length === 0) {
              dialog.update({ notice: 'Nothing changed.' })
              return
            }
            // A saved edit is done; the dialog closes. Uploads and removals stay open for the next one.
            void run(() => updateServerDetails(current(), patch), 'Saved.').then(() => {
              if (dialog.model.error === undefined) dialog.close()
            })
            return
          }
          case 'upload':
            void run(
              async () =>
                uploadServerAsset(
                  current(),
                  intent.kind,
                  new Uint8Array(await intent.file.arrayBuffer()),
                  intent.file.type,
                ),
              intent.kind === 'logo' ? 'Logo uploaded.' : 'Preview uploaded.',
            )
            return
          case 'clear-asset':
            void run(
              () => deleteServerAsset(current(), intent.kind),
              intent.kind === 'logo' ? 'Logo removed.' : 'Preview removed.',
            )
            return
        }
      },
    },
  )
}
