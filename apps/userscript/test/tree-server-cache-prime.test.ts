import { afterEach, expect, it, vi } from 'vitest'
import { primeFromCache, rowsFor } from '../src/application/tree-server-state.js'
import { cacheServer } from '../src/server-cache.js'
import { removeServer } from '../src/server-connections.js'
import { type ServerConnection, setState } from '../src/settings.js'

const URL = 'https://prime.example'

const server = (season: number): ServerConnection => ({
  url: URL,
  info: null,
  token: null,
  status: 'unreachable',
  isAdmin: false,
  season: null,
  lastVerified: { serverId: 'prime', season },
})

const cache = (season: number) =>
  cacheServer({ url: URL, serverId: 'prime', season, nodes: [], templates: [], fetchedAt: 0 })

afterEach(async () => {
  await removeServer(URL)
  setState({ servers: [] })
})

it('reads each verified server identity from the cache once, and again after it changes', async () => {
  const rerender = vi.fn()
  await cache(1)
  setState({ servers: [server(1)] })

  await primeFromCache(rerender)
  await primeFromCache(rerender)
  expect(rowsFor(server(1))).toBeDefined()
  expect(rerender).toHaveBeenCalledTimes(1)

  await cache(2)
  setState({ servers: [server(2)] })
  await primeFromCache(rerender)
  expect(rowsFor(server(2))).toBeDefined()
  expect(rerender).toHaveBeenCalledTimes(2)
})

it('reads again when an earlier read filled in nothing', async () => {
  // A read that finds nothing looks the same as one that failed: `loadServerCache` answers `[]`.
  const rerender = vi.fn()
  setState({ servers: [server(1)] })
  await primeFromCache(rerender)
  expect(rowsFor(server(1))).toBeUndefined()

  await cache(1)
  await primeFromCache(rerender)
  expect(rowsFor(server(1))).toBeDefined()
  expect(rerender).toHaveBeenCalledTimes(1)
})
