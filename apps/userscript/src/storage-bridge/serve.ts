import type { Build } from '../page-claim.js'
import { pageWindow } from '../page-world.js'
import { BRIDGE_HANDOFF, type BridgeMessage, type PageMessage } from './protocol.js'

/** Where a build keeps its stored strings, seen from its storage world. */
export interface StringStore {
  /** Every stored string, or `null` when storage could not be read. */
  load(): Promise<Record<string, string> | null>
  /** Store `value` under `key`, or delete it for `null`. Resolves `false` when that failed. */
  write(key: string, value: string | null): Promise<boolean>
  /** Run `listener` with each change made in another context, `null` for a delete. */
  onChange?(listener: (changes: Record<string, string | null>) => void): void
  /**
   * Report changes to `key` from now on, where changes are only reported for watched keys. Returns
   * the value it has now, or `null`.
   */
  watch?(key: string): string | null
}

/**
 * Serve `store` to the page-world copy of `build` once it hands over its port. See `protocol.ts`.
 *
 * Call it before that copy can run, so this listener is the first on `window` and can stop the
 * handoff before any page listener sees it. Returns a function that stops waiting for the handoff.
 */
export const serveStorageBridge = (build: Build, store: StringStore): (() => void) => {
  const loaded = store.load()
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
    // No port: the other build runs this page, so the bridge stays closed.
    const port = event.ports[0]
    if (port === undefined) return
    const send = (message: BridgeMessage): void => port.postMessage(JSON.stringify(message))
    // Writes and syncs settle in the order they were sent, so a sync answers after every earlier
    // write is stored: what lets a tab hand shared values to the next under a Web Lock.
    let queue: Promise<unknown> = loaded
    let writeFailed = false
    port.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as PageMessage
      queue = queue.then(async () => {
        if (message.type === 'write') {
          if (!(await store.write(message.key, message.value))) writeFailed = true
          return
        }
        if (message.type === 'watch') {
          const value = store.watch?.(message.key) ?? null
          if (value !== null) send({ type: 'watched', key: message.key, value })
          return
        }
        const values = writeFailed ? null : await store.load()
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
