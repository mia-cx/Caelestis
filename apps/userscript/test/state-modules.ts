/** Settings, server connections and the server API as one namespace, imported fresh after `vi.resetModules()`. */
export const importStateModules = async () => ({
  ...(await import('../src/settings.js')),
  ...(await import('../src/server-connections.js')),
  ...(await import('../src/server-api.js')),
})
