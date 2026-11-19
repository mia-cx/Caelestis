import type { BackfillPreview, BackfillProgress, FolderBackfillPreview } from '@caelestis/shared'
import { errorText } from '../error-text.js'
import { hasServerAdminToken, isCurrentServerConnection } from '../server-connections.js'
import { serverRequest } from '../server-request.js'
import { templateById } from '../templates/catalog.js'
import { templateAsPng } from '../templates/residency.js'
import { serverTemplateKey } from '../tree-keys.js'
import { openModalHost } from './modal-host.js'
import type { TreeTarget } from './tree-context.js'

/** Whether a row can offer Backfill history: it is on the world, on a season-0 server. */
export const canBackfill = (target: TreeTarget): boolean =>
  target.surface.kind === 'world' && target.server?.season === 0

/**
 * Open an admin form whose background import outlives this userscript tab, for one server
 * template or every template below a server folder.
 */
export const openBackfill = (target: TreeTarget): void => {
  const { server, templateId, nodeId } = target
  const path =
    templateId !== undefined
      ? `/admin/backfill/${templateId}`
      : nodeId !== null
        ? `/admin/backfill/folders/${nodeId}`
        : null
  if (server === null || path === null || !hasServerAdminToken(server) || !canBackfill(target))
    return
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let imageUrl: string | null = null
  let preview: BackfillPreview | FolderBackfillPreview | null = null
  const request = async <T>(action: string, body?: object): Promise<T> => {
    if (!isCurrentServerConnection(server) || !hasServerAdminToken(server))
      throw new Error('Server connection changed. Close and reopen backfill.')
    const { response, body: value } = await serverRequest(server, `${path}/${action}`, {
      ...(body === undefined ? {} : { method: 'POST', json: body }),
      limits: 'interactive',
      read: 'json',
      signal: controller.signal,
    })
    if (!response.ok)
      throw new Error(
        value !== null &&
          typeof value === 'object' &&
          'error' in value &&
          typeof value.error === 'string'
          ? value.error
          : `Backfill request failed (HTTP ${response.status}).`,
      )
    if (!isCurrentServerConnection(server))
      throw new Error('Server connection changed. Close and reopen backfill.')
    return value as T
  }
  const poll = (): void => {
    clearTimeout(timer)
    if (dialog.closed || dialog.model.job?.status !== 'running') return
    timer = setTimeout(() => {
      void request<BackfillProgress | null>('job')
        .then((job) => {
          dialog.update({ job })
          poll()
        })
        .catch((error: unknown) =>
          dialog.update({ error: `${errorText(error)} Reload to check the job.` }),
        )
    }, 2_000)
  }
  const reload = async (): Promise<void> => {
    dialog.update({ loading: true, error: null })
    const [jobResult, previewResult] = await Promise.allSettled([
      request<BackfillProgress | null>('job'),
      request<BackfillPreview | FolderBackfillPreview>('preview'),
    ])
    if (jobResult.status === 'fulfilled') dialog.update({ job: jobResult.value })
    if (previewResult.status === 'fulfilled') {
      preview = previewResult.value
      const selected =
        preview.snapshots.find((snapshot) => snapshot.id === dialog.model.selectedSnapshot) ??
        preview.snapshots.find((snapshot) => snapshot.at === dialog.model.job?.from) ??
        preview.snapshots[0]
      dialog.update({
        preview,
        selectedSnapshot: selected?.id ?? null,
        ...('bases' in preview ? { templates: preview.bases.length } : {}),
      })
    } else dialog.update({ error: errorText(previewResult.reason) })
    if (jobResult.status === 'rejected') dialog.update({ error: errorText(jobResult.reason) })
    dialog.update({ loading: false })
    poll()
  }
  const mutate = async (action: 'start' | 'cancel'): Promise<void> => {
    const { model } = dialog
    if (
      model.busy ||
      (action === 'start' &&
        (model.loading ||
          preview === null ||
          model.selectedSnapshot === null ||
          model.job?.status === 'running'))
    )
      return
    dialog.update({ busy: true, error: null })
    clearTimeout(timer)
    try {
      const snapshotId = model.selectedSnapshot
      // The artwork the form showed, so the server can refuse a start against changed templates.
      const body =
        action !== 'start' || preview === null
          ? {}
          : 'bases' in preview
            ? { versionIds: preview.bases.map((basis) => basis.versionId), snapshotId }
            : { versionId: preview.basis.versionId, snapshotId }
      dialog.update({ job: await request<BackfillProgress | null>(action, body) })
    } catch (error) {
      dialog.update({
        error: `${errorText(error)} Reload to check whether the request completed.`,
      })
    } finally {
      dialog.update({ busy: false })
      poll()
    }
  }
  const dialog = openModalHost(
    'caelestis-backfill',
    {
      name: target.name,
      templates: templateId === undefined ? 0 : null,
      previewUrl: null,
      preview: null,
      job: null,
      selectedSnapshot: null,
      loading: true,
      busy: false,
      error: null,
    },
    {
      onIntent: (intent) => {
        if (intent.type === 'select') dialog.update({ selectedSnapshot: intent.snapshotId })
        else if (intent.type === 'reload') {
          if (!dialog.model.busy && !dialog.model.loading) void reload()
        } else void mutate(intent.type)
      },
      onClose: () => {
        clearTimeout(timer)
        controller.abort()
      },
      onClosed: () => {
        if (imageUrl !== null) URL.revokeObjectURL(imageUrl)
      },
    },
  )
  const template =
    templateId === undefined ? undefined : templateById(serverTemplateKey(server.url, templateId))
  if (template !== undefined)
    void templateAsPng(template)
      .then((blob) => {
        if (dialog.closed || blob === null) return
        imageUrl = URL.createObjectURL(blob)
        dialog.update({ previewUrl: imageUrl })
      })
      .catch((error: unknown) =>
        dialog.update({ error: `Artwork preview unavailable: ${errorText(error)}` }),
      )
  void reload()
}
