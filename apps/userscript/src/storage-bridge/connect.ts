import { claimPage } from '../page-claim.js'
import { BRIDGE_HANDOFF, type Build } from '../page-markers.js'
import { useStoredValues } from '../stored-values.js'
import type { BridgeMessage, PageMessage } from './protocol.js'

let askForResource: ((name: string) => Promise<string>) | null = null

/**
 * The userscript's `@resource` called `name` as a `data:` URL, read by the manager's world over
 * the storage bridge. Rejects without a bridge, or when the manager could not read it.
 */
export const bridgedResource = (name: string): Promise<string> =>
  askForResource?.(name) ?? Promise.reject(new Error('no storage bridge to read resources over'))

/**
 * Claim the page for `build`, unless `standby`, and take its stored values over the storage bridge.
 * See `protocol.ts`.
 *
 * Runs at document start in the page world. Every read before the snapshot arrives returns the
 * default rather than a page-readable fallback; `onSnapshot` runs once it has, told whether this
 * copy claimed the page, and changes made elsewhere afterwards apply as they arrive. Returns
 * whether this copy claimed the page. One that did not must install nothing: its values are only
 * for the build that did (see `build-transfer.ts`).
 */
export const connectStorageBridge = (
  build: Build,
  onSnapshot: (claimed: boolean) => void,
  standby = false,
): boolean => {
  const claimed = !standby && claimPage(build)
  const values = new Map<string, string>()
  const channel = new MessageChannel()
  const port = channel.port1
  const send = (message: PageMessage): void => port.postMessage(JSON.stringify(message))
  const syncs = new Map<number, (values: Record<string, string> | null) => void>()
  let lastSync = 0
  const resources = new Map<number, (url: string | null) => void>()
  let lastResource = 0
  askForResource = (name) =>
    new Promise((resolve, reject) => {
      const id = ++lastResource
      resources.set(id, (url) =>
        url === null ? reject(new Error(`resource ${name} is out of reach`)) : resolve(url),
      )
      send({ type: 'resource', id, name })
    })
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
        onSnapshot(claimed)
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
      case 'resource':
        resources.get(message.id)?.(message.url)
        resources.delete(message.id)
        break
    }
  }
  // The bridge hears from this script before any Wplace script can post.
  window.postMessage({ type: BRIDGE_HANDOFF, build }, location.origin, [channel.port2])
  return claimed
}
