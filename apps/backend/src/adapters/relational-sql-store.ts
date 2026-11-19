import { archiveGate, fencedConnection } from '../archive/fence.js'
import { RelationalAccessTokenStore } from '../auth/relational.js'
import type { AccessTokenStore } from '../auth/store.js'
import { RelationalNodeStore } from '../nodes/relational.js'
import type { NodeStore } from '../nodes/store.js'
import type { SqlStore } from '../ports/sql-store.js'
import { RelationalServerSettingsStore } from '../server/relational.js'
import type { ServerSettingsStore } from '../server/store.js'
import { RelationalTagStore } from '../tags/relational.js'
import type { TagStore } from '../tags/store.js'
import { RelationalAlarmStore } from '../telemetry/alarms/relational.js'
import type { AlarmStore } from '../telemetry/alarms/store.js'
import { RelationalTileBlobStore } from '../telemetry/blobs/relational.js'
import type { TileBlobStore } from '../telemetry/blobs/store.js'
import { RelationalHistoryStore } from '../telemetry/history/relational.js'
import type { HistoryStore } from '../telemetry/history/store.js'
import { RelationalTileStore } from '../telemetry/tiles/relational.js'
import type { TileStore } from '../telemetry/tiles/store.js'
import { RelationalTemplateStore } from '../templates/relational.js'
import type { TemplateStore } from '../templates/store.js'
import { RelationalRegionStore } from '../work/relational-region-store.js'
import { RelationalWorkStore } from '../work/relational-store.js'
import type { SqlConnection } from './sql-connection.js'

/** The feature store classes `relationalSqlStore` builds; a test replaces one with a subclass. */
export interface RelationalFeatures {
  readonly nodes?: typeof RelationalNodeStore
  readonly templates?: typeof RelationalTemplateStore
  readonly tags?: typeof RelationalTagStore
  readonly tokens?: typeof RelationalAccessTokenStore
  readonly settings?: typeof RelationalServerSettingsStore
  readonly tileBlobs?: typeof RelationalTileBlobStore
  readonly tiles?: typeof RelationalTileStore
  readonly alarms?: typeof RelationalAlarmStore
  readonly history?: typeof RelationalHistoryStore
}

/**
 * `store`'s methods bound to it, as own properties of a plain object, so several feature stores
 * spread into one bundle. Spreading the instance itself would copy none of its prototype methods.
 * Name the feature interface as `Store`: that is what the bundle exposes.
 */
const methodsOf = <Store extends object>(store: Store): Store => {
  const methods: Record<string, unknown> = {}
  for (
    let prototype: object | null = Object.getPrototypeOf(store);
    prototype !== null && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const member: unknown = Reflect.get(store, name)
      if (name !== 'constructor' && !(name in methods) && typeof member === 'function')
        methods[name] = member.bind(store)
    }
  }
  // Reflection: every method `Store` declares lives on the prototype chain walked above.
  return methods as Store
}

/**
 * Every relational feature store over one database, each writing through the archive fence.
 * `features` swaps a feature class for a subclass, which is how tests inject faults and delays.
 */
export const relationalSqlStore = (
  connection: SqlConnection,
  features: RelationalFeatures = {},
): SqlStore => {
  const database = fencedConnection(connection)
  return {
    archiveOperationActive: archiveGate(connection),
    regions: new RelationalRegionStore(database),
    work: new RelationalWorkStore(database),
    ...methodsOf<NodeStore>(new (features.nodes ?? RelationalNodeStore)(database)),
    ...methodsOf<TemplateStore>(new (features.templates ?? RelationalTemplateStore)(database)),
    ...methodsOf<TagStore>(new (features.tags ?? RelationalTagStore)(database)),
    ...methodsOf<AccessTokenStore>(new (features.tokens ?? RelationalAccessTokenStore)(database)),
    ...methodsOf<ServerSettingsStore>(
      new (features.settings ?? RelationalServerSettingsStore)(database),
    ),
    ...methodsOf<TileBlobStore>(new (features.tileBlobs ?? RelationalTileBlobStore)(database)),
    ...methodsOf<TileStore>(new (features.tiles ?? RelationalTileStore)(database)),
    ...methodsOf<AlarmStore>(new (features.alarms ?? RelationalAlarmStore)(database)),
    ...methodsOf<HistoryStore>(new (features.history ?? RelationalHistoryStore)(database)),
  }
}
