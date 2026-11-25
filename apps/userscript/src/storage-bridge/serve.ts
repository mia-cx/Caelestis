import { BRIDGE_HANDOFF, type Build } from '../page-markers.js'
import { pageWindow } from '../page-world.js'
import type { BridgeMessage, PageMessage } from './protocol.js'

/** Where a build keeps its stored strings, seen from its storage world. */
export interface StringStore {
  /** Every stored string. Rejects when storage could not be read. */
  load(): Promise<Record<string, string>>
  /** Store `value` under `key`, or delete it for `null`. Rejects when that failed. */
  write(key: string, value: string | null): Promise<void>
  /** Run `listener` with each change made in another context, `null` for a delete. */
  onChange?(listener: (changes: Record<string, string | null>) => void): void
  /**
   * Report changes to `key` from now on, where changes are only reported for watched keys. Returns
   * the value it has now, or `null`.
   */
  watch?(key: string): string | null
  /** The userscript's `@resource` called `name`, as a `data:` URL. The extension has none. */
  resource?(name: string): Promise<string>
}

/**
 * Serve `store` to the page-world copy of `build` once it hands over its port. See `protocol.ts`.
 *
 * Call it before that copy can run, so this listener is the first on `window` and can stop the
 * handoff before any page listener sees it. Returns a function that stops waiting for the handoff.
 */
export const serveStorageBridge = (build: Build, store: StringStore): (() => void) => {
  // Storage failures end here: an unreadable store serves defaults, a failed write makes the next
  // sync answer `null`, and a failed watch answers nothing.
  const load = (): Promise<Record<string, string> | null> =>
    store.load().catch((error: unknown) => {
      console.warn('[caelestis] could not load stored values', error)
      return null
    })
  const loaded = load()
  const onHandoff = (event: MessageEvent): void => {
    // Violentmonkey hands granted scripts a proxy for `window`; the event carries the page's own.
    if (
      (event.source !== window && event.source !== pageWindow()) ||
      event.data?.type !== BRIDGE_HANDOFF ||
      event.data?.build !== build
    )
      return
    event.stopImmediatePropagation()
    stop()
    // Only the first handoff counts; without a port, the bridge stays closed.
    const port = event.ports[0]
    if (port === undefined) return
    const send = (message: BridgeMessage): void => port.postMessage(JSON.stringify(message))
    // Writes and syncs settle in the order they were sent, so a sync answers after every earlier
    // write is stored: what lets a tab hand shared values to the next under a Web Lock.
    let queue: Promise<unknown> = loaded
    let writeFailed = false
    port.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as PageMessage
      if (message.type === 'resource') {
        const { id, name } = message
        Promise.resolve()
          .then(() => store.resource?.(name) ?? null)
          .catch((error: unknown) => {
            console.warn(`[caelestis] could not read resource ${name}`, error)
            return null
          })
          .then((url) => send({ type: 'resource', id, url }))
        return
      }
      queue = queue.then(async () => {
        if (message.type === 'write') {
          await store.write(message.key, message.value).catch((error: unknown) => {
            console.warn(`[caelestis] could not store ${message.key}`, error)
            writeFailed = true
          })
          return
        }
        if (message.type === 'watch') {
          let value: string | null = null
          try {
            value = store.watch?.(message.key) ?? null
          } catch (error) {
            console.warn(`[caelestis] could not watch ${message.key}`, error)
          }
          if (value !== null) send({ type: 'watched', key: message.key, value })
          return
        }
        const values = writeFailed ? null : await load()
        writeFailed = false
        send({ type: 'synced', id: message.id, values })
      })
    }
    void loaded.then((values) => {
      // Unreadable storage at load: Caelestis starts on its defaults, as a fresh install would.
      send({ type: 'snapshot', values: values ?? {} })
      store.onChange?.((changes) => send({ type: 'changes', changes }))
    })
  }
  const stop = (): void => window.removeEventListener('message', onHandoff, true)
  window.addEventListener('message', onHandoff, true)
  return stop
}
