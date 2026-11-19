import type {
  ArchiveHistory,
  ArchiveSnapshot,
  BackfillJob,
  BackfillPreview,
  FolderBackfillJob,
  FolderBackfillPreview,
  TileCoord,
} from '@caelestis/shared'
import { type D1Usage, measureD1Usage } from '../metrics/request-metrics.js'

/** A user-correctable import refusal, distinct from an upstream or storage failure. */
export class BackfillError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message)
  }
}

/** Durable storage needed by the import, independent of the Cloudflare adapter. */
export interface BackfillStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  list<T>(options: { prefix: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>
  delete(keys: string[]): Promise<number>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

/**
 * One bounded page of an import's durable keys. Values are JSON, as every coordinator storage
 * adapter requires. Wakeups stay out: a paused job keeps re-arming while an archive is read.
 */
export type BackfillStatePage = readonly (readonly [string, unknown])[]

/**
 * One template's backfill state, where its basis, tile observations and samples live and its
 * history is read from. A template job writes its own; a folder job reaches each template's.
 */
export interface BackfillSink {
  get<T>(key: string): Promise<T | undefined>
  put(entries: BackfillStatePage): Promise<void>
}

/**
 * A canvas archive. Snapshot ids are hours since 2025-01-01, and the archive stores each tile's
 * snapshots one week to a file, so reading a week's snapshots in a row costs one download.
 */
export interface ArchiveSource {
  snapshots(): Promise<readonly ArchiveSnapshot[]>
  tile(snapshotId: number, tile: TileCoord): Promise<Uint8Array | null>
}

const HOURS_PER_ARCHIVE_WEEK = 168

/** The archive week, and so the archive file, a snapshot belongs to. */
export const archiveWeek = (snapshotId: number): number =>
  Math.floor(snapshotId / HOURS_PER_ARCHIVE_WEEK)

/** The import commands a backfill client forwards. */
export interface BackfillImporter {
  preview(templateId: string): Promise<BackfillPreview>
  start(templateId: string, versionId: string, snapshotId: number): Promise<BackfillJob>
  job(): Promise<BackfillJob | null>
  cancel(): Promise<BackfillJob | null>
  history(versionId: string, tile?: TileCoord): Promise<ArchiveHistory>
  previewFolder(nodeId: string): Promise<FolderBackfillPreview>
  startFolder(
    nodeId: string,
    versionIds: readonly string[],
    snapshotId: number,
  ): Promise<FolderBackfillJob>
  folderJob(): Promise<FolderBackfillJob | null>
  cancelFolder(): Promise<FolderBackfillJob | null>
}

export type BackfillReply<T> = (
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly status: 400 | 404 | 409 | 502 | 503 }
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
  importer: BackfillImporter,
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

const unsupported = (): Promise<never> =>
  Promise.reject(new BackfillError('This server does not support backfill yet.', 503))

/** A host without an import worker, such as tests: commands refuse and history is empty. */
export const noBackfill: BackfillClients = () =>
  localBackfillClient({
    preview: unsupported,
    start: unsupported,
    job: unsupported,
    cancel: unsupported,
    previewFolder: unsupported,
    startFolder: unsupported,
    folderJob: unsupported,
    cancelFolder: unsupported,
    history: async () => ({ source: 'eralyon', basis: null, samples: [], frames: [] }),
  })
