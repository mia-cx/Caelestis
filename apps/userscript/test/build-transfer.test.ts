import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STATE = 'caelestis.state.v2'
const HANDED_OFF = 'caelestis.local.handed-off'
const RECEIVING = 'caelestis.local.receiving'

/**
 * One copy of Caelestis on the shared test page. Its storage behaves like the extension's: each
 * write is stored or fails on its own, and a sync fails after a failed write.
 */
const copy = async (
  stored: Record<string, string> | Map<string, string>,
  failing: ReadonlySet<string> = new Set(),
) => {
  vi.resetModules()
  const store = stored instanceof Map ? stored : new Map(Object.entries(stored))
  const values = new Map(store)
  let writeFailed = false
  const module = await import('../src/stored-values.js')
  module.useStoredValues(values, {
    persist: (key, value) => {
      if (failing.has(key)) writeFailed = true
      else if (value === null) store.delete(key)
      else store.set(key, value)
    },
    fetch: async () => {
      if (writeFailed) {
        writeFailed = false
        throw new Error('stored values are out of reach')
      }
      return Object.fromEntries(store)
    },
  })
  const transfer = await import('../src/build-transfer.js')
  const port = transfer.meetOtherBuild(page)
  if (port === null) throw new Error('met nobody')
  return { store, values, transfer, port }
}

const reload = () => vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)

/** The page's `window` both copies share, fresh for each test. */
let page: object = {}

/** Document start: the parser has not added `<head>` yet, though Caelestis may have added its styles. */
beforeEach(() => {
  page = {}
  document.documentElement.replaceChildren(document.createElement('style'))
})
afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.replaceChildren(
    document.createElement('head'),
    document.createElement('body'),
  )
})

describe('moving settings between the userscript and the extension', () => {
  it('an empty extension takes the userscript’s values, and the userscript yields after', async () => {
    const reloaded = reload()
    const extension = await copy({})
    const userscript = await copy({ [STATE]: '{"servers":["mine"]}' })

    extension.transfer.linkOtherBuild(extension.port, 'extension', true)
    userscript.transfer.serveOtherBuild(userscript.port, 'userscript')

    await vi.waitFor(() => expect(reloaded).toHaveBeenCalled())
    expect(Object.fromEntries(extension.values)).toEqual({ [STATE]: '{"servers":["mine"]}' })
    expect(userscript.values.get(HANDED_OFF)).toBe('true')
  })

  it('a userscript fills an empty extension, then yields to it', async () => {
    const reloaded = reload()
    const userscript = await copy({ [STATE]: '{"servers":["mine"]}' })
    const extension = await copy({})

    userscript.transfer.linkOtherBuild(userscript.port, 'userscript', false)
    extension.transfer.serveOtherBuild(extension.port, 'extension')

    await vi.waitFor(() => expect(reloaded).toHaveBeenCalled())
    expect(Object.fromEntries(extension.values)).toEqual({ [STATE]: '{"servers":["mine"]}' })
    expect(userscript.values.get(HANDED_OFF)).toBe('true')
  })

  it('a transfer whose mark cannot be stored writes nothing, and the next load retries', async () => {
    const reloaded = reload()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const extension = await copy({}, new Set([RECEIVING]))
    const userscript = await copy({ [STATE]: '{"servers":["mine"]}' })
    extension.transfer.linkOtherBuild(extension.port, 'extension', true)
    userscript.transfer.serveOtherBuild(userscript.port, 'userscript')

    await vi.waitFor(() => expect(warned).toHaveBeenCalled())
    expect(reloaded).not.toHaveBeenCalled()
    expect(userscript.values.has(HANDED_OFF)).toBe(false)
    expect(Object.fromEntries(extension.store)).toEqual({})

    // The next load, on a fresh page, with storage working again.
    page = {}
    const retry = await copy(extension.store)
    const again = await copy(userscript.store)
    retry.transfer.linkOtherBuild(retry.port, 'extension', retry.transfer.awaitingSettings())
    again.transfer.serveOtherBuild(again.port, 'userscript')

    await vi.waitFor(() => expect(reloaded).toHaveBeenCalled())
    expect(Object.fromEntries(extension.store)).toEqual({ [STATE]: '{"servers":["mine"]}' })
    expect(again.store.get(HANDED_OFF)).toBe('true')
  })

  it('a transfer that stops partway keeps its mark, so the next load retries', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const extension = await copy({}, new Set(['caelestis.second']))
    const userscript = await copy({ 'caelestis.first': '1', 'caelestis.second': '2' })
    extension.transfer.linkOtherBuild(extension.port, 'extension', true)
    userscript.transfer.serveOtherBuild(userscript.port, 'userscript')

    await vi.waitFor(() => expect(warned).toHaveBeenCalled())
    expect(userscript.values.has(HANDED_OFF)).toBe(false)
    expect(extension.store.get(RECEIVING)).toBe('true')
    page = {}
    expect((await copy(extension.store)).transfer.awaitingSettings()).toBe(true)
  })

  it('import replaces this build’s values with the other build’s, keeping local ones', async () => {
    const reloaded = reload()
    const extension = await copy({ [STATE]: 'extension', 'caelestis.old': 'gone' })
    const userscript = await copy({ [STATE]: 'userscript', [HANDED_OFF]: 'true' })
    extension.transfer.linkOtherBuild(extension.port, 'extension', false)
    userscript.transfer.serveOtherBuild(userscript.port, 'userscript')
    await vi.waitFor(() => expect(extension.transfer.otherBuild()).toBe('userscript'))

    await extension.transfer.importFromOtherBuild()

    expect(Object.fromEntries(extension.values)).toEqual({ [STATE]: 'userscript' })
    expect(reloaded).toHaveBeenCalledOnce()
  })

  it('send replaces the other build’s values with this build’s', async () => {
    const extension = await copy({ [STATE]: 'extension' })
    const userscript = await copy({ [STATE]: 'userscript', 'caelestis.old': 'gone' })
    extension.transfer.linkOtherBuild(extension.port, 'extension', false)
    userscript.transfer.serveOtherBuild(userscript.port, 'userscript')
    await vi.waitFor(() => expect(extension.transfer.otherBuild()).toBe('userscript'))

    await extension.transfer.sendToOtherBuild()

    expect(Object.fromEntries(userscript.values)).toEqual({ [STATE]: 'extension' })
  })

  it('closes the meeting once the page starts, and page code cannot plant another', async () => {
    await copy({})
    document.documentElement.append(document.createElement('head'))
    await vi.waitFor(() => expect(Reflect.get(page, '__caelestisMeeting')).toBeUndefined())

    const planted = new MessageChannel()
    expect(Reflect.set(page, '__caelestisMeeting', planted.port2)).toBe(false)
    expect(() =>
      Object.defineProperty(page, '__caelestisMeeting', { value: planted.port2 }),
    ).toThrow()
    vi.resetModules()
    const late = await import('../src/build-transfer.js')
    expect(late.meetOtherBuild(page)).toBeNull()
  })

  it('hands the offer out once', async () => {
    await copy({})

    expect(typeof (Reflect.get(page, '__caelestisMeeting') as MessagePort).postMessage).toBe(
      'function',
    )
    expect(Reflect.get(page, '__caelestisMeeting')).toBeUndefined()
  })
})
