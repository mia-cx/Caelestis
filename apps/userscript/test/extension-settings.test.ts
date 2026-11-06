import { describe, expect, it, vi } from 'vitest'

const STATE_KEY = 'caelestis.state.v2'
const SHARE_TILES_KEY = 'caelestis.setting.shareTiles'

/**
 * A tab or the popup: its modules over its own cache of one shared extension store. Writes reach
 * the store at once; nothing reaches another context's cache until a test delivers it, which is
 * the window in which storage notifications are still on their way.
 */
const extensionContext = async (store: Map<string, string>) => {
  vi.resetModules()
  const values = new Map(store)
  const storage = await import('../src/stored-values.js')
  const adopt = storage.useStoredValues(values, {
    persist: (key, value) => (value === null ? store.delete(key) : store.set(key, value)),
    fetch: async () => Object.fromEntries(store),
  })
  const state = await import('../src/state.js')
  return { adopt, state }
}

const sharedStore = (stored: Record<string, unknown>) =>
  new Map([[STATE_KEY, JSON.stringify(stored)]])

describe('global settings in the extension', () => {
  it('a popup change applies to an open tab without replacing its servers', async () => {
    const store = sharedStore({ servers: [{ url: 'https://example.test', token: 'saved' }] })
    const tab = await extensionContext(store)
    const loaded = tab.state.loadState()
    const listener = vi.fn()
    tab.state.onStateChange(listener)

    tab.adopt({ [SHARE_TILES_KEY]: 'false' })

    expect(tab.state.getState().shareTiles).toBe(false)
    expect(tab.state.getState().servers).toBe(loaded.servers)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("ignores a change that only echoes the tab's own write", async () => {
    const store = sharedStore({})
    const tab = await extensionContext(store)
    tab.state.loadState()
    tab.state.setState({ shareTiles: false })
    const listener = vi.fn()
    tab.state.onStateChange(listener)

    tab.adopt({ [SHARE_TILES_KEY]: 'false', [STATE_KEY]: store.get(STATE_KEY) ?? null })

    expect(listener).not.toHaveBeenCalled()
  })

  it('a popup switch keeps a tab save it has not heard about yet', async () => {
    const store = sharedStore({ panelWidth: 400 })
    const tab = await extensionContext(store)
    const popup = await extensionContext(store)
    tab.state.loadState()

    tab.state.setState({ panelWidth: 500 })
    popup.state.storeGlobalSetting('shareTiles', false)

    const reloaded = (await extensionContext(store)).state.loadState()
    expect(reloaded.panelWidth).toBe(500)
    expect(reloaded.shareTiles).toBe(false)
  })

  it('a tab save keeps a popup switch it has not heard about yet', async () => {
    const store = sharedStore({ shareTiles: true })
    const tab = await extensionContext(store)
    const popup = await extensionContext(store)
    tab.state.loadState()

    popup.state.storeGlobalSetting('shareTiles', false)
    tab.state.setState({ panelWidth: 500 })

    const reloaded = (await extensionContext(store)).state.loadState()
    expect(reloaded.panelWidth).toBe(500)
    expect(reloaded.shareTiles).toBe(false)
  })
})
