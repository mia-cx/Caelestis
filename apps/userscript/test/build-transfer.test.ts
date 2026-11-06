import { afterEach, describe, expect, it, vi } from 'vitest'

const STATE = 'caelestis.state.v2'
const HANDED_OFF = 'caelestis.local.handed-off'

/** One copy of Caelestis on the shared test page, with its own storage. */
const copy = async (stored: Record<string, string>) => {
  vi.resetModules()
  const values = new Map(Object.entries(stored))
  const storage = await import('../src/stored-values.js')
  storage.useStoredValues(values, {
    persist: () => undefined,
    fetch: async () => Object.fromEntries(values),
  })
  const transfer = await import('../src/build-transfer.js')
  return { values, transfer, port: transfer.meetOtherBuild() }
}

const reload = () => vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)

afterEach(() => vi.restoreAllMocks())

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

  it('withdraws an offer nobody took once the page’s first script appears', async () => {
    await copy({})
    expect(Reflect.has(window, '__caelestisMeeting')).toBe(true)

    document.head.append(document.createElement('script'))

    await vi.waitFor(() => expect(Reflect.has(window, '__caelestisMeeting')).toBe(false))
  })
})
