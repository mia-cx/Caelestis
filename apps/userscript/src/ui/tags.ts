import type { TagManagerIntent } from '@caelestis/ui/elements'
import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { refreshServerSnapshot } from '../application/tree-server-state.js'
import {
  isCurrentServerConnection,
  listServerTags,
  mutateServerTag,
  onServerContents,
} from '../state.js'
import { mutateLocalTag, onLocalTags, readLocalTags } from '../templates/tags.js'
import { openModalHost } from './modal-host.js'
import type { TreeTarget } from './tree.js'

/** Open the same tag workflow for browser-owned and server-owned templates or catalogs. */
export const openTagManager = (target: TreeTarget, rerender: () => void): void => {
  const server = target.server
  const templateId =
    server === null && target.key.startsWith('local:')
      ? target.key.slice('local:'.length)
      : target.templateId
  const folderId =
    server === null
      ? target.key.startsWith('lf:')
        ? target.key.slice(3)
        : undefined
      : target.templateId === undefined
        ? (target.nodeId ?? undefined)
        : undefined
  let refreshPending = false
  let reloadPending = false
  const checkConnection = (): void => {
    if (server !== null && !isCurrentServerConnection(server))
      throw new Error('The server connection changed. Close and reopen tags.')
  }
  const read = async (): Promise<void> => {
    checkConnection()
    if (server === null) {
      const tags = await readLocalTags()
      dialog.update({
        tags,
        selected: tags
          .filter((tag) =>
            folderId !== undefined
              ? tag.folderIds?.includes(folderId)
              : templateId !== undefined && tag.templateIds.includes(templateId),
          )
          .map((tag) => tag.id),
        ready: true,
      })
      rerender()
      return
    }
    const result = await listServerTags(server, templateId, folderId)
    checkConnection()
    if (!result.ok) throw new Error(result.message)
    dialog.update({ tags: result.tags, selected: result.selected, ready: true })
  }
  const failure = (error: unknown): string => {
    if (server !== null && navigator.onLine === false)
      return 'You are offline. Reconnect and reload tags.'
    const message = error instanceof Error ? error.message : String(error)
    return /failed to fetch|network|timed out/i.test(message)
      ? 'Could not reach the server. Check your connection and reload tags.'
      : message
  }
  const refreshTemplates = async (): Promise<void> => {
    if (server === null) return
    checkConnection()
    if (target.surface?.kind !== undefined && target.surface.kind !== 'world') {
      const result = await refreshAllianceManifest(server, target.surface)
      if (result.status === 'failed' || result.status === 'skipped')
        throw new Error('The alliance template list could not refresh. Reload tags to retry.')
    }
    const result = await refreshServerSnapshot(server, rerender, true)
    if (result.status !== 'admitted')
      throw new Error('The template list could not refresh. Reload tags to retry.')
    refreshPending = false
  }
  const reload = async (): Promise<void> => {
    reloadPending = false
    dialog.update({ loading: true, error: undefined })
    try {
      await read()
      if (refreshPending) await refreshTemplates()
    } catch (error) {
      dialog.update({ error: failure(error) })
    } finally {
      dialog.update({ loading: false })
      reloadIfPending()
    }
  }
  const reloadIfPending = (): void => {
    if (reloadPending && !dialog.closed && !dialog.model.busy && !dialog.model.loading)
      void reload()
  }
  const mutate = async (
    intent: Exclude<TagManagerIntent, { type: 'close' | 'closed' | 'retry' }>,
  ): Promise<void> => {
    if (dialog.model.busy || dialog.model.loading || !dialog.model.ready) return
    dialog.update({ busy: true, error: undefined })
    let committed = false
    try {
      checkConnection()
      if (intent.type === 'assign' && templateId === undefined && folderId === undefined)
        throw new Error('Select a template or folder to assign tags.')
      const mutation =
        intent.type !== 'assign'
          ? intent
          : folderId !== undefined
            ? { ...intent, type: 'assign-folder' as const, folderId }
            : { ...intent, templateId: templateId ?? '' }
      if (server === null) await mutateLocalTag(mutation)
      else {
        const result = await mutateServerTag(server, mutation)
        if (!result.ok) throw new Error(result.message)
      }
      committed = true
      refreshPending = server !== null
      dialog.update({ revision: dialog.model.revision + 1 })
      await read()
      await refreshTemplates()
    } catch (error) {
      dialog.update({ error: `${committed ? 'Saved. ' : ''}${failure(error)}` })
    } finally {
      dialog.update({ busy: false })
      rerender()
      reloadIfPending()
    }
  }
  const dialog = openModalHost(
    'caelestis-tag-manager',
    {
      owner:
        server === null ? 'Local · This browser' : `${server.info?.name ?? server.url} · Server`,
      ...(templateId === undefined && folderId === undefined ? {} : { targetName: target.name }),
      tags: [],
      selected: [],
      loading: true,
      ready: false,
      busy: false,
      revision: 0,
    },
    {
      onIntent: (intent) => {
        if (intent.type !== 'retry') void mutate(intent)
        else if (!dialog.model.busy && !dialog.model.loading) void reload()
      },
      onClose: () => {
        unsubscribe()
        unsubscribeLocal?.()
      },
    },
  )
  const unsubscribe = onServerContents((owner) => {
    if (server === null || owner.url !== server.url) return
    reloadPending = true
    reloadIfPending()
  })
  const unsubscribeLocal =
    server === null
      ? onLocalTags(() => {
          reloadPending = true
          reloadIfPending()
        })
      : undefined
  void reload()
}
