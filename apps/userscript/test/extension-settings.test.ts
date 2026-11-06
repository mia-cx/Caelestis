import { describe, expect, it, vi } from 'vitest'

const STATE_KEY = 'caelestis.state.v2'

/** A fresh tab or popup: its modules over the extension's stored values. */
const extensionContext = async (stored: Record<string, unknown>) => {
  vi.resetModules()
  const values = new Map([[STATE_KEY, JSON.stringify(stored)]])
  const writes: [string, string | null][] = []
  const storage = await import('../src/stored-values.js')
  const adopt = storage.useStoredValues(values, {
    persist: (key, value) => writes.push([key, value]),
    fetch: async () => Object.fromEntries(values),
  })
  const state = await import('../src/state.js')
  return { adopt, state, values, writes }
}

describe('global settings in the extension', () => {
  it('a popup change applies to an open tab without replacing its servers', async () => {
    const tab = await extensionContext({
      servers: [{ url: 'https://example.test', token: 'saved', info: null }],
      shareTiles: true,
    })
    const loaded = tab.state.loadState()
    const listener = vi.fn()
    tab.state.onStateChange(listener)

    tab.adopt({ [STATE_KEY]: JSON.stringify({ servers: [], shareTiles: false }) })

    expect(tab.state.getState().shareTiles).toBe(false)
    expect(tab.state.getState().servers).toBe(loaded.servers)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("ignores a change that only echoes the tab's own write", async () => {
    const tab = await extensionContext({ shareTiles: true })
    tab.state.loadState()
    tab.state.setState({ shareTiles: false })
    const listener = vi.fn()
    tab.state.onStateChange(listener)

    tab.adopt({ [STATE_KEY]: tab.values.get(STATE_KEY) ?? null })

    expect(listener).not.toHaveBeenCalled()
  })

  it('the popup changes one setting and keeps the rest of the stored state', async () => {
    const popup = await extensionContext({
      servers: [{ url: 'https://example.test', token: 'saved', info: null }],
      panelWidth: 400,
    })

    popup.state.storeGlobalSetting('reportPaints', false)

    const written = JSON.parse(popup.values.get(STATE_KEY) ?? '{}')
    expect(written).toMatchObject({ panelWidth: 400, reportPaints: false })
    expect(written.servers).toEqual([{ url: 'https://example.test', token: 'saved', info: null }])
    expect(popup.state.storedGlobalSettings().reportPaints).toBe(false)
    expect(popup.writes).toEqual([[STATE_KEY, popup.values.get(STATE_KEY)]])
  })
})
