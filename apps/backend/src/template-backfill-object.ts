import { DurableObject } from 'cloudflare:workers'
import type { TileCoord } from '@caelestis/shared'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { relationalSqlStore } from './adapters/relational-sql-store.js'
import { EralyonArchive } from './backfill/eralyon.js'
import { TemplateBackfill } from './backfill/import.js'
import { backfillReply } from './backfill/port.js'
import { instrumentD1 } from './metrics/request-metrics.js'

/**
 * One template's serialized import commands and durable alarm-driven history. Named by a folder
 * instead, it runs that folder's import and writes each template's results to its own object.
 */
export class TemplateBackfillObject extends DurableObject<Env> {
  private readonly importer: TemplateBackfill
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.importer = new TemplateBackfill(
      ctx.storage,
      relationalSqlStore(instrumentD1(env.DB)),
      new R2BlobStore(env.BLOBS),
      new EralyonArchive(),
      Date.now,
      (templateId) => {
        const template = env.TEMPLATE_BACKFILL.getByName(templateId)
        return {
          get: async <T>(key: string) => (await template.readState(key)) as T | undefined,
          put: (entries) => template.importState(entries),
        }
      },
    )
  }
  async preview(templateId: string) {
    return backfillReply(() => this.importer.preview(templateId))
  }
  async job() {
    return backfillReply(() => this.importer.job())
  }
  async history(versionId: string, tile?: TileCoord) {
    return backfillReply(() => this.importer.history(versionId, tile))
  }
  async start(templateId: string, versionId: string, snapshotId: number) {
    return this.ctx.blockConcurrencyWhile(() =>
      backfillReply(() => this.importer.start(templateId, versionId, snapshotId)),
    )
  }
  async previewFolder(nodeId: string) {
    return backfillReply(() => this.importer.previewFolder(nodeId))
  }
  async folderJob() {
    return backfillReply(() => this.importer.folderJob())
  }
  async startFolder(nodeId: string, versionIds: readonly string[], snapshotId: number) {
    return this.ctx.blockConcurrencyWhile(() =>
      backfillReply(() => this.importer.startFolder(nodeId, versionIds, snapshotId)),
    )
  }
  async cancelFolder() {
    return this.ctx.blockConcurrencyWhile(() => backfillReply(() => this.importer.cancelFolder()))
  }
  exportState(...args: Parameters<TemplateBackfill['exportState']>) {
    return this.importer.exportState(...args)
  }
  readState(key: string) {
    return this.importer.readState(key)
  }
  importState(...args: Parameters<TemplateBackfill['importState']>) {
    return this.ctx.blockConcurrencyWhile(() => this.importer.importState(...args))
  }
  discardState(...args: Parameters<TemplateBackfill['discardState']>) {
    return this.ctx.blockConcurrencyWhile(() => this.importer.discardState(...args))
  }
  async cancel() {
    return this.ctx.blockConcurrencyWhile(() => backfillReply(() => this.importer.cancel()))
  }
  override async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.importer.step())
  }
}
