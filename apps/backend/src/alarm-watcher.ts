import { DurableObject } from 'cloudflare:workers'
import { millis } from '@caelestis/shared'
import { cloudflareStores } from './adapters/cloudflare/bindings.js'
import { runAlarmWatcherCycle, scheduleAlarmWakeup } from './alarm-watcher-cycle.js'

/** Owns the delayed ten-minute verification without competing with TelemetryShard's flush alarm. */
export class AlarmWatcher extends DurableObject<Env> {
  private readonly stores: ReturnType<typeof cloudflareStores>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.stores = cloudflareStores(env)
  }

  schedule(): Promise<void> {
    return scheduleAlarmWakeup(this.stores.sql, this.ctx.storage)
  }

  override alarm(): Promise<void> {
    return runAlarmWatcherCycle(this.stores, this.ctx.storage, millis(Date.now()))
  }
}
