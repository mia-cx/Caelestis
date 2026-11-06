import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STATE = 'caelestis.state.v2'
const HANDED_OFF = 'caelestis.local.handed-off'
const RECEIVING = 'caelestis.local.receiving'

/** One copy of Caelestis on the shared test page, with its own storage. */
const copy = async (stored: Record<string, string>, storage: { failSync?: boolean } = {}) => {
  vi.resetModules()
  const values = new Map(Object.entries(stored))
  const module = await import('../src/stored-values.js')
  module.useStoredValues(values, {
    persist: () => undefined,
    fetch: async () => {
      if (storage.failSync === true) throw new Error('stored values are out of reach')
      return Object.fromEntries(values)
    },
  })
  const transfer = await import('../src/build-transfer.js')
  const port = transfer.meetOtherBuild()
  if (port === null) throw new Error('met nobody')
  return { values, transfer, port }
}

const reload = () => vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)

/** Document start: the parser has not added `<head>` yet, though Caelestis may have added its styles. */
beforeEach(() => document.documentElement.replaceChildren(document.createElement('style')))
afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, '__caelestisMeeting')
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

  it('a transfer that fails to store keeps the userscript running and is retried', async () => {
    const reloaded = reload()
    const extension = await copy({}, { failSync: true })
    const userscript = await copy({ [STATE]: '{"servers":["mine"]}' })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    extension.transfer.linkOtherBuild(extension.port, 'extension', true)
    userscript.transfer.serveOtherBuild(userscript.port, 'userscript')

    await vi.waitFor(() => expect(warned).toHaveBeenCalled())
    expect(reloaded).not.toHaveBeenCalled()
    expect(userscript.values.has(HANDED_OFF)).toBe(false)
    expect(extension.values.get(RECEIVING)).toBe('true')
    expect(extension.transfer.awaitingSettings()).toBe(true)
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

  it('withdraws an offer once the document gains content, and a later copy meets nobody', async () => {
    await copy({})
    document.documentElement.append(document.createElement('head'))
    await vi.waitFor(() => expect(Reflect.has(window, '__caelestisMeeting')).toBe(false))
    // Page code plants its own offer, hoping a late userscript serves it.
    const planted = new MessageChannel()
    Reflect.set(window, '__caelestisMeeting', planted.port2)

    vi.resetModules()
    const late = await import('../src/build-transfer.js')

    expect(late.meetOtherBuild()).toBeNull()
    expect(Reflect.get(window, '__caelestisMeeting')).toBe(planted.port2)
  })
})
