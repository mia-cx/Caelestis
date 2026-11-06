// @vitest-environment-options {"url": "https://wplace.live/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'https://wplace.live'
const chunk = (name: string): string => `${ORIGIN}/_app/immutable/chunks/${name}.js`

/** Wplace's modules as served, by URL. */
let served: Map<string, string>
let reads: string[]
let loaded: string[]
let failing: Set<string>
/** Reads that answer only once their promise settles. */
let held: Map<string, Promise<void>>

beforeEach(() => {
  document.body.innerHTML = '<canvas class="maplibregl-canvas"></canvas>'
  // The entry imports `a`, which imports `b`.
  served = new Map([
    [chunk('entry'), 'import "./a.js"'],
    [chunk('a'), 'import "./b.js"'],
    [chunk('b'), 'export const b = 1'],
  ])
  reads = []
  loaded = [chunk('entry'), `${ORIGIN}/tiles/1/2.png`]
  failing = new Set()
  held = new Map()
  vi.spyOn(performance, 'getEntriesByType').mockImplementation(
    () => loaded.map((name) => ({ name })) as never,
  )
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    reads.push(url)
    await held.get(url)
    const source = served.get(url)
    if (source === undefined || failing.has(url)) return new Response(null, { status: 503 })
    return new Response(source)
  }
  vi.stubGlobal('fetch', fetch)
  Object.assign(window, { fetch })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.resetModules()
})

/** A fresh copy of the discovery, so each case starts with nothing read. */
const discovery = async () => (await import('../src/templates/native-store.js')).findWplaceModules

const nothing = { absent: () => false }

describe('Wplace module discovery', () => {
  it('reads each module once for lookups that start together', async () => {
    const find = await discovery()
    await Promise.all([find(nothing), find(nothing), find(nothing)])
    expect(reads.sort()).toEqual([chunk('a'), chunk('b'), chunk('entry')])
  })

  it('reads only the modules Wplace loaded since the last lookup', async () => {
    const find = await discovery()
    await find(nothing)
    served.set(chunk('alliance'), 'import "./b.js"')
    loaded.push(chunk('alliance'))
    reads = []
    await find(nothing)
    expect(reads).toEqual([chunk('alliance')])
  })

  it('reads a module again after its read failed', async () => {
    const find = await discovery()
    failing.add(chunk('b'))
    await expect(find(nothing)).rejects.toThrow('Could not inspect Wplace modules')
    failing.clear()
    reads = []
    await find(nothing)
    expect(reads).toEqual([chunk('b')])
  })

  it('lets a failed read finish its batch before the next lookup retries it', async () => {
    served.set(chunk('entry'), 'import "./a.js"; import "./c.js"')
    served.set(chunk('c'), 'export const c = 1')
    failing.add(chunk('a'))
    let release = (): void => {}
    held.set(chunk('c'), new Promise((resolve) => (release = resolve)))
    const find = await discovery()
    const lookups = [find(nothing), find(nothing)]
    await vi.waitFor(() => expect(reads).toContain(chunk('c')))
    release()
    for (const lookup of lookups)
      await expect(lookup).rejects.toThrow('Could not inspect Wplace modules')
    expect(reads.sort()).toEqual([chunk('a'), chunk('a'), chunk('c'), chunk('entry')])
  })
})
