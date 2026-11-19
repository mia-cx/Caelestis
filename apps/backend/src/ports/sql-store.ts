import type { ArchiveStatus } from '../archive/fence.js'
import type { AccessTokenStore } from '../auth/store.js'
import type { NodeStore } from '../nodes/store.js'
import type { ServerSettingsStore } from '../server/store.js'
import type { TagStore } from '../tags/store.js'
import type { AlarmStore } from '../telemetry/alarms/store.js'
import type { TileBlobStore } from '../telemetry/blobs/store.js'
import type { HistoryStore } from '../telemetry/history/store.js'
import type { TileStore } from '../telemetry/tiles/store.js'
import type { TemplateStore } from '../templates/store.js'
import type { RegionStore } from '../work/region-store.js'
import type { WorkStore } from '../work/store.js'

/**
 * Every relational feature store in one object, for `makeBackendContext` to provide and runtimes to
 * build once per database. A consumer depends on the feature interface it uses, not on this.
 *
 * No generic `query(sql)` escape hatch: one would make every caller a dialect dependency.
 */
export interface SqlStore
  extends NodeStore,
    TemplateStore,
    TagStore,
    AccessTokenStore,
    ServerSettingsStore,
    TileBlobStore,
    TileStore,
    AlarmStore,
    HistoryStore,
    ArchiveStatus {
  readonly regions: RegionStore
  readonly work: WorkStore
}
