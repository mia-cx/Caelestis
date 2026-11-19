import { afterEach, expect, it } from 'vitest'
import { openMemoryDatabase } from '../src/node/memory-stores.js'

const stores: ReturnType<typeof openMemoryDatabase>[] = []

afterEach(() => Promise.all(stores.splice(0).map((store) => store.close())))

it('leaves no partial write visible after a SQLite transaction throws', async () => {
  const store = openMemoryDatabase()
  stores.push(store)
  const { connection, sql } = store

  await expect(
    connection.transaction(async (transaction) => {
      await transaction
        .prepare('INSERT INTO server_settings (id, name, description) VALUES (?, ?, ?)')
        .bind(1, 'rolled back', null)
        .run()
      throw new Error('abort')
    }),
  ).rejects.toThrow('abort')
  expect(await sql.readServerSettings()).toMatchObject({ name: null, description: null })
})
