import type { ObjectStorage } from '@caelestis/storage'
import { ObjectBlobStore } from '../adapters/object-blob-store.js'
import { relationalSqlStore } from '../adapters/relational-sql-store.js'
import type { SqlConnection } from '../adapters/sql-connection.js'

/** The relational store over a database connection or transaction. Every host builds it here. */
export const sqlStore = (connection: SqlConnection) => relationalSqlStore(connection)

/** The stores every host builds over its database and object storage. */
export const portableStores = (connection: SqlConnection, objects: ObjectStorage) => ({
  sql: sqlStore(connection),
  blobs: new ObjectBlobStore(objects),
})

export type PortableStores = ReturnType<typeof portableStores>
