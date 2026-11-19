import type { ObjectStorage } from '@caelestis/storage'
import { ObjectBlobStore } from '../adapters/object-blob-store.js'
import { relationalSqlStore } from '../adapters/relational-sql-store.js'
import type { SqlConnection } from '../adapters/sql-connection.js'

export const portableStores = (connection: SqlConnection, objects: ObjectStorage) => ({
  sql: relationalSqlStore(connection),
  blobs: new ObjectBlobStore(objects),
})

export type PortableStores = ReturnType<typeof portableStores>
