import type { BackfillArchive } from '../archive/port.js'
import { EralyonArchive } from '../backfill/eralyon.js'
import { TemplateBackfill } from '../backfill/import.js'
import {
  type BackfillClient,
  type BackfillStatePage,
  type BackfillStorage,
  localBackfillClient,
} from '../backfill/port.js'
import type { BlobStore, SqlStore } from '../ports/index.js'
import type { SerialQueue } from '../runtime/serial-queue.js'

/** One import object as both hosts expose it: commands, archive state, and its wakeup. */
export interface BackfillHandle extends BackfillClient, BackfillArchive {
  readState(key: string): Promise<unknown>
  writeState(page: BackfillStatePage): Promise<void>
  step(): Promise<void>
}

/** Where a folder import reaches each template's own import. */
export type BackfillHandles = (name: string) => Pick<BackfillHandle, 'readState' | 'writeState'>

/**
 * One import over its durable storage. `exclusive` serialises every command that writes the
 * import's state, and the reads of that state, so a step admitted before an archive gate finishes
 * before the archive reads its state. A Durable Object passes `blockConcurrencyWhile`; Node passes
 * one serial queue per import.
 */
export const openBackfill = (
  storage: BackfillStorage,
  stores: { readonly sql: SqlStore; readonly blobs: BlobStore },
  exclusive: SerialQueue,
  handles: BackfillHandles,
): BackfillHandle => {
  const importer = new TemplateBackfill(
    storage,
    stores.sql,
    stores.blobs,
    new EralyonArchive(),
    Date.now,
    (templateId) => {
      const template = handles(templateId)
      return {
        // The import's state is JSON its own writer put there under the same key.
        get: async <T>(key: string) => (await template.readState(key)) as T | undefined,
        put: (entries) => template.writeState(entries),
      }
    },
  )
  return {
    ...localBackfillClient(importer, exclusive),
    readState: (key) => exclusive(() => importer.readState(key)),
    writeState: (page) => exclusive(() => importer.writeState(page)),
    exportState: (startAfter, limit) => exclusive(() => importer.exportState(startAfter, limit)),
    importState: (page) => exclusive(() => importer.importState(page)),
    discardState: (limit) => exclusive(() => importer.discardState(limit)),
    step: () => exclusive(() => importer.step()),
  }
}
