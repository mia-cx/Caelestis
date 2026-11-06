import { type Build, claimPage } from '../page-claim.js'
import { useStoredValues } from '../stored-values.js'
import { BRIDGE_HANDOFF, type BridgeMessage, type PageMessage } from './protocol.js'

/**
 * Claim the page for `build` and take its stored values over the storage bridge. See `protocol.ts`.
 *
 * Runs at document start in the page world. Every read before the snapshot arrives returns the
 * default rather than a page-readable fallback; `onSnapshot` runs once it has, and changes made
 * elsewhere afterwards apply as they arrive. Returns whether this copy claimed the page; one that
 * did not closes its bridge and must install nothing.
 */
export const connectStorageBridge = (build: Build, onSnapshot: () => void): boolean => {
  // Whichever way it goes, the bridge hears from this script before any Wplace script can post.
  if (!claimPage(build)) {
    window.postMessage({ type: BRIDGE_HANDOFF, build }, location.origin)
    return false
  }
  const values = new Map<string, string>()
  const channel = new MessageChannel()
  const port = channel.port1
  const send = (message: PageMessage): void => port.postMessage(JSON.stringify(message))
  const syncs = new Map<number, (values: Record<string, string> | null) => void>()
  let lastSync = 0
  const watched = new Set<string>()
  /** Keys this page has written, whose `watched` answers are older than what it holds. */
  const written = new Set<string>()
  const adopt = useStoredValues(values, {
    persist(key, value) {
      written.add(key)
      send({ type: 'write', key, value })
    },
    watch(key) {
      if (watched.has(key)) return
      watched.add(key)
      send({ type: 'watch', key })
    },
    fetch: () =>
      new Promise((resolve, reject) => {
        const id = ++lastSync
        syncs.set(id, (values) =>
          values === null ? reject(new Error('stored values are out of reach')) : resolve(values),
        )
        send({ type: 'sync', id })
      }),
  })
  port.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as BridgeMessage
    switch (message.type) {
      case 'snapshot':
        for (const [key, value] of Object.entries(message.values)) values.set(key, value)
        onSnapshot()
        break
      case 'changes':
        adopt(message.changes)
        break
      case 'watched':
        if (!written.has(message.key)) adopt({ [message.key]: message.value })
        break
      case 'synced':
        syncs.get(message.id)?.(message.values)
        syncs.delete(message.id)
        break
    }
  }
  window.postMessage({ type: BRIDGE_HANDOFF, build }, location.origin, [channel.port2])
  return true
}
