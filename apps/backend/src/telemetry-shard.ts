import { cloudflareStores } from './adapters/cloudflare/bindings.js'
import { durableCoordinatorDatabase } from './adapters/cloudflare/coordinator-database.js'
import { forwardingObject } from './adapters/cloudflare/forwarding-object.js'
import { TELEMETRY_SHARD_METHODS, TelemetryCoordinator } from './coordination/telemetry.js'

export class TelemetryShard extends forwardingObject<TelemetryCoordinator>()(
  TELEMETRY_SHARD_METHODS,
) {
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
