import { StaleArchiveOperationError } from '../../archive/gate.js'
import type { CounterArchive } from '../../archive/port.js'
import type { CounterArchiveTable } from '../../coordination/telemetry.js'
import type { CounterDelta, CounterStore, PendingCounters } from '../../ports/index.js'
import type { TelemetryShard } from '../../telemetry-shard.js'

const SINGLE_SHARD_NAME = 'telemetry'

export class DurableObjectCounterStore implements CounterStore, CounterArchive {
  constructor(private readonly namespace: DurableObjectNamespace<TelemetryShard>) {}

  /**
   * A stub belongs to the request that created it, and the Worker reuses this store across
   * requests, so resolve the shard on every call as the status read model does.
   */
  private get shard(): DurableObjectStub<TelemetryShard> {
    return this.namespace.getByName(SINGLE_SHARD_NAME)
  }

  async record(deltas: readonly CounterDelta[], idempotencyKey?: string): Promise<void> {
    await this.shard.record(deltas, idempotencyKey)
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    return this.shard.readPending(templateIds)
  }

  async readDroppedLateCount(): Promise<number> {
    return this.shard.readDroppedLateCount()
  }

  async readFlushFailureCount(): Promise<number> {
    return this.shard.readFlushFailureCount()
  }

  exportCounterRows(
    table: CounterArchiveTable,
    after: readonly (string | number)[] | null,
    limit: number,
  ): Promise<Record<string, string | number>[]> {
    return this.shard.exportCounterRows(table, after, limit)
  }

  async importCounterRows(
    token: string,
    table: CounterArchiveTable,
    rows: readonly Readonly<Record<string, string | number>>[],
  ): Promise<void> {
    try {
      await this.shard.importCounterRows(token, table, rows)
    } catch (error) {
      // RPC errors arrive as plain Errors; restore the type the restore relies on.
      if (error instanceof Error && error.message === new StaleArchiveOperationError().message)
        throw new StaleArchiveOperationError()
      throw error
    }
  }

  async discardCounterRows(): Promise<void> {
    await this.shard.discardCounterRows()
  }

  async freeze(operationId: string): Promise<void> {
    await this.shard.freeze(operationId)
  }

  async thaw(operationId: string): Promise<void> {
    await this.shard.thaw(operationId)
  }
}
