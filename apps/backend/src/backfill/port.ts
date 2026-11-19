import type {
  ArchiveHistory,
  BackfillJob,
  BackfillPreview,
  FolderBackfillJob,
  FolderBackfillPreview,
  TileCoord,
} from '@caelestis/shared'
import { type D1Usage, measureD1Usage } from '../metrics/request-metrics.js'
import { BackfillError, type TemplateBackfill } from './import.js'

export type BackfillReply<T> = (
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly status: 400 | 404 | 409 | 502 }
) & { readonly usage: D1Usage }

/** Preserve D1 usage and expected errors across the Durable Object RPC boundary. */
export const backfillReply = async <T>(run: () => Promise<T>): Promise<BackfillReply<T>> => {
  const measured = await measureD1Usage(run)
  if (measured.success) return { ok: true, value: measured.value, usage: measured.usage }
  const { error, usage } = measured
  if (error instanceof BackfillError)
    return { ok: false, error: error.message, status: error.status, usage }
  console.error('Template backfill failed', error)
  return {
    ok: false,
    error: 'Backfill service is unavailable. Retry in a moment.',
    status: 502,
    usage,
  }
}

export interface BackfillClient {
  preview(templateId: string): Promise<BackfillReply<BackfillPreview>>
  start(
    templateId: string,
    versionId: string,
    snapshotId: number,
  ): Promise<BackfillReply<BackfillJob>>
  job(): Promise<BackfillReply<BackfillJob | null>>
  cancel(): Promise<BackfillReply<BackfillJob | null>>
  history(versionId: string, tile?: TileCoord): Promise<BackfillReply<ArchiveHistory>>
  previewFolder(nodeId: string): Promise<BackfillReply<FolderBackfillPreview>>
  startFolder(
    nodeId: string,
    versionIds: readonly string[],
    snapshotId: number,
  ): Promise<BackfillReply<FolderBackfillJob>>
  folderJob(): Promise<BackfillReply<FolderBackfillJob | null>>
  cancelFolder(): Promise<BackfillReply<FolderBackfillJob | null>>
}

/** The import object named by a template id, or by `folderBackfillName` for a folder. */
export type BackfillClients = (name: string) => BackfillClient

/** Folder imports live beside template imports, under a name no template id can take. */
export const folderBackfillName = (nodeId: string): string => `folder:${nodeId}`

/** A client over an importer in this process; `exclusive` serializes its commands. */
export const localBackfillClient = (
  importer: TemplateBackfill,
  exclusive: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation(),
): BackfillClient => ({
  preview: (template) => backfillReply(() => importer.preview(template)),
  job: () => backfillReply(() => importer.job()),
  history: (version, tile) => backfillReply(() => importer.history(version, tile)),
  start: (template, version, snapshot) =>
    exclusive(() => backfillReply(() => importer.start(template, version, snapshot))),
  cancel: () => exclusive(() => backfillReply(() => importer.cancel())),
  previewFolder: (node) => backfillReply(() => importer.previewFolder(node)),
  folderJob: () => backfillReply(() => importer.folderJob()),
  startFolder: (node, versions, snapshot) =>
    exclusive(() => backfillReply(() => importer.startFolder(node, versions, snapshot))),
  cancelFolder: () => exclusive(() => backfillReply(() => importer.cancelFolder())),
})
