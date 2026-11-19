import { DurableObject } from 'cloudflare:workers'
import { cloudflareStores } from './adapters/cloudflare/bindings.js'
import { durableCoordinatorDatabase } from './adapters/cloudflare/coordinator-database.js'
import { TelemetryCoordinator } from './coordination/telemetry.js'
import type { CounterDelta } from './ports/index.js'

/** The telemetry coordinator. DO RPC exposes only prototype methods, so each one delegates. */
export class TelemetryShard extends DurableObject<Env> {
  private readonly coordinator: TelemetryCoordinator
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.coordinator = new TelemetryCoordinator(
      durableCoordinatorDatabase(ctx.storage),
      ctx.storage,
      cloudflareStores(env).sql,
    )
    void ctx.blockConcurrencyWhile(() => this.coordinator.initialize())
  }
  record(deltas: readonly CounterDelta[], key?: string) {
    return this.coordinator.record(deltas, key)
  }
  readPending(ids: readonly string[]) {
    return this.coordinator.readPending(ids)
  }
  readDroppedLateCount() {
    return this.coordinator.readDroppedLateCount()
  }
  readFlushFailureCount() {
    return this.coordinator.readFlushFailureCount()
  }
  exportCounterRows(...args: Parameters<TelemetryCoordinator['exportCounterRows']>) {
    return this.coordinator.exportCounterRows(...args)
  }
  importCounterRows(...args: Parameters<TelemetryCoordinator['importCounterRows']>) {
    return this.coordinator.importCounterRows(...args)
  }
  discardCounterRows(operationId: string) {
    return this.coordinator.discardCounterRows(operationId)
  }
  beginCounterImport(operationId: string) {
    return this.coordinator.beginCounterImport(operationId)
  }
  beginCounterDiscard(operationId: string) {
    return this.coordinator.beginCounterDiscard(operationId)
  }
  closeCounterOperation(operationId: string) {
    return this.coordinator.closeCounterOperation(operationId)
  }
  freeze(operationId: string) {
    return this.coordinator.freeze(operationId)
  }
  thaw(operationId: string) {
    return this.coordinator.thaw(operationId)
  }
  override alarm() {
    return this.coordinator.alarm()
  }
}
