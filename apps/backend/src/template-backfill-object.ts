import { cloudflareStores } from './adapters/cloudflare/bindings.js'
import { forwardingObject } from './adapters/cloudflare/forwarding-object.js'
import { type BackfillHandle, openBackfill } from './server/backfill.js'

/**
 * One template's serialized import commands and durable alarm-driven history. Named by a folder
 * instead, it runs that folder's import and writes each template's results to its own object.
 */
export class TemplateBackfillObject extends forwardingObject<BackfillHandle>()([
  'preview',
  'job',
  'history',
  'start',
  'cancel',
  'previewFolder',
  'folderJob',
  'startFolder',
  'cancelFolder',
  'readState',
  'exportState',
  'importState',
  'discardState',
]) {
  protected readonly target: BackfillHandle
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.target = openBackfill(
      ctx.storage,
      cloudflareStores(env),
      (operation) => ctx.blockConcurrencyWhile(operation),
      (name) => env.TEMPLATE_BACKFILL.getByName(name),
    )
  }
  override alarm(): Promise<void> {
    return this.target.step()
  }
}
