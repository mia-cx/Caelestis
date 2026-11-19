import { DurableObject } from 'cloudflare:workers'
import { cloudflareStores } from './adapters/cloudflare/bindings.js'
import { type BackfillHandle, openBackfill } from './server/backfill.js'

/**
 * One template's serialized import commands and durable alarm-driven history. Named by a folder
 * instead, it runs that folder's import and writes each template's results to its own object.
 * DO RPC exposes only prototype methods, so each one delegates.
 */
export class TemplateBackfillObject extends DurableObject<Env> {
  private readonly backfill: BackfillHandle
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.backfill = openBackfill(
      ctx.storage,
      cloudflareStores(env),
      (operation) => ctx.blockConcurrencyWhile(operation),
      (name) => env.TEMPLATE_BACKFILL.getByName(name),
    )
  }
  preview(...args: Parameters<BackfillHandle['preview']>) {
    return this.backfill.preview(...args)
  }
  job() {
    return this.backfill.job()
  }
  history(...args: Parameters<BackfillHandle['history']>) {
    return this.backfill.history(...args)
  }
  start(...args: Parameters<BackfillHandle['start']>) {
    return this.backfill.start(...args)
  }
  cancel() {
    return this.backfill.cancel()
  }
  previewFolder(...args: Parameters<BackfillHandle['previewFolder']>) {
    return this.backfill.previewFolder(...args)
  }
  folderJob() {
    return this.backfill.folderJob()
  }
  startFolder(...args: Parameters<BackfillHandle['startFolder']>) {
    return this.backfill.startFolder(...args)
  }
  cancelFolder() {
    return this.backfill.cancelFolder()
  }
  readState(key: string) {
    return this.backfill.readState(key)
  }
  exportState(...args: Parameters<BackfillHandle['exportState']>) {
    return this.backfill.exportState(...args)
  }
  importState(...args: Parameters<BackfillHandle['importState']>) {
    return this.backfill.importState(...args)
  }
  discardState(...args: Parameters<BackfillHandle['discardState']>) {
    return this.backfill.discardState(...args)
  }
  override alarm(): Promise<void> {
    return this.backfill.step()
  }
}
