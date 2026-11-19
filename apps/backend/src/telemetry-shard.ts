import { cloudflareStores } from './adapters/cloudflare/bindings.js'
import { durableCoordinatorDatabase } from './adapters/cloudflare/coordinator-database.js'
import { forwardingObject } from './adapters/cloudflare/forwarding-object.js'
import { TelemetryCoordinator } from './coordination/telemetry.js'

/** The telemetry coordinator. */
export class TelemetryShard extends forwardingObject<TelemetryCoordinator>()([
  'record',
  'readPending',
  'readDroppedLateCount',
  'readFlushFailureCount',
  'exportCounterRows',
  'importCounterRows',
  'discardCounterRows',
  'beginCounterImport',
  'beginCounterDiscard',
  'closeCounterOperation',
  'freeze',
  'thaw',
]) {
  protected readonly target: TelemetryCoordinator
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.target = new TelemetryCoordinator(
      durableCoordinatorDatabase(ctx.storage),
      ctx.storage,
      cloudflareStores(env).sql,
    )
    void ctx.blockConcurrencyWhile(() => this.target.initialize())
  }
  override alarm() {
    return this.target.alarm()
  }
}
