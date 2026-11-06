import { warn } from './debug.js'
import type { Build } from './page-claim.js'
import { pageWindow } from './page-world.js'
import {
  deleteStoredValue,
  LOCAL_KEY_PREFIX,
  portableValues,
  replacePortableValues,
  storedValue,
  storeValue,
  syncStoredValues,
} from './stored-values.js'

/**
 * Moving servers and settings between the userscript and the extension, with both installed.
 *
 * Only one copy runs Caelestis on a page (see `page-claim.ts`). The other installs nothing and
 * serves its own storage to the running copy over a private `MessagePort`: Import pulls its values
 * across, Send pushes the running copy's values into it. The first switch to the extension needs no
 * button: an extension with nothing stored takes the userscript's values on its first load, and the
 * userscript then yields to it on every load (`HANDED_OFF_KEY`).
 */

/** Set in the userscript once the extension stored its values; it then yields to it. */
export const HANDED_OFF_KEY = `${LOCAL_KEY_PREFIX}handed-off`

/** Set while values from the other build are being stored, and cleared once all of them are. */
const RECEIVING_KEY = `${LOCAL_KEY_PREFIX}receiving`

/**
 * Whether this copy still waits for its first settings: it has none, or a transfer into it stopped
 * partway. Either way the automatic switch fills it.
 */
export const awaitingSettings = (): boolean =>
  Object.keys(portableValues()).length === 0 || storedValue(RECEIVING_KEY) === 'true'

/** Replace this copy's values with `values`, so that a failure partway is retried. */
const receive = async (values: Record<string, string>): Promise<void> => {
  storeValue(RECEIVING_KEY, 'true')
  replacePortableValues(values)
  await syncStoredValues()
  deleteStoredValue(RECEIVING_KEY)
  await syncStoredValues()
}

const MEETING = '__caelestisMeeting'

/** Whether the parser has started the page: every Wplace script lives in its head or body. */
const pageStarted = (): boolean => document.head !== null || document.body !== null

/**
 * This copy's end of the channel to the other build, or `null` when it is too late to meet.
 *
 * Both copies call this at document start. The first leaves the other end on the page's `window`;
 * the second takes it. The meeting holds only until the parser adds `<head>` or `<body>`, which
 * it does before any page script can run, so no offer can be Wplace's. A copy that starts later
 * meets nobody, and an offer nobody took is removed at that moment. Caelestis's own elements, such
 * as its font styles at the root, don't count.
 */
export const meetOtherBuild = (): MessagePort | null => {
  if (pageStarted()) return null
  const page = pageWindow() as unknown as Record<string, unknown>
  const offered = page[MEETING]
  if (offered !== undefined) {
    delete page[MEETING]
    return offered as MessagePort
  }
  const channel = new MessageChannel()
  Object.defineProperty(page, MEETING, { value: channel.port2, configurable: true })
  const observer = new MutationObserver(() => {
    if (!pageStarted()) return
    if (page[MEETING] === channel.port2) delete page[MEETING]
    observer.disconnect()
  })
  observer.observe(document, { childList: true, subtree: true })
  return channel.port1
}

/** Running copy to serving copy. */
type Request =
  | { readonly type: 'read'; readonly id: number }
  | { readonly type: 'replace'; readonly id: number; readonly values: Record<string, string> }
  /** Yield from now on, its values being stored: only the userscript is ever asked. */
  | { readonly type: 'hand-off'; readonly id: number }

/** Serving copy to running copy. */
type Reply =
  | { readonly type: 'hello'; readonly build: Build; readonly empty: boolean }
  | {
      readonly type: 'done'
      readonly id: number
      readonly ok: boolean
      readonly values?: Record<string, string>
    }

const post = (port: MessagePort, message: Request | Reply): void =>
  port.postMessage(JSON.stringify(message))

/**
 * Serve this copy's storage to the copy running Caelestis. Call once stored values are loaded.
 */
export const serveOtherBuild = (port: MessagePort, build: Build): void => {
  port.onmessage = ({ data }) => {
    const request = JSON.parse(String(data)) as Request
    void (async () => {
      try {
        if (request.type === 'replace') await receive(request.values)
        if (request.type === 'hand-off') {
          storeValue(HANDED_OFF_KEY, 'true')
          await syncStoredValues()
        }
        const values = request.type === 'read' ? { values: portableValues() } : {}
        post(port, { type: 'done', id: request.id, ok: true, ...values })
      } catch (error) {
        warn('install', `could not ${request.type} for the other build`, String(error))
        post(port, { type: 'done', id: request.id, ok: false })
      }
    })()
  }
  post(port, { type: 'hello', build, empty: awaitingSettings() })
}

let other: Build | null = null
let link: MessagePort | null = null
let lastRequest = 0
const pending = new Map<number, (reply: Extract<Reply, { type: 'done' }>) => void>()
const listeners = new Set<() => void>()

/** The other build, while it is installed and serving its storage to this one. */
export const otherBuild = (): Build | null => other

export const onOtherBuildChange = (listener: () => void): void => {
  listeners.add(listener)
}

const ask = (request: Request): Promise<Record<string, string>> => {
  const port = link
  if (port === null) return Promise.reject(new Error('the other build is not installed'))
  return new Promise((resolve, reject) => {
    pending.set(request.id, (reply) =>
      reply.ok ? resolve(reply.values ?? {}) : reject(new Error('the other build failed')),
    )
    post(port, request)
  })
}

/** Replace this build's servers and settings with the other build's, then reload. */
export const importFromOtherBuild = async (): Promise<void> => {
  await receive(await ask({ type: 'read', id: ++lastRequest }))
  pageWindow().location.reload()
}

/** Replace the other build's servers and settings with this build's. */
export const sendToOtherBuild = async (): Promise<void> => {
  await syncStoredValues()
  await ask({ type: 'replace', id: ++lastRequest, values: portableValues() })
}

/**
 * The first switch, with no button: the userscript's values fill an extension still awaiting its
 * settings, and only once the extension stored all of them does the userscript yield.
 */
const handOff = async (running: Build, from: Build, empty: boolean, awaiting: boolean) => {
  if (running === 'extension' && from === 'userscript' && awaiting && !empty) {
    await receive(await ask({ type: 'read', id: ++lastRequest }))
    await ask({ type: 'hand-off', id: ++lastRequest })
    pageWindow().location.reload()
  } else if (running === 'userscript' && from === 'extension' && empty) {
    if (Object.keys(portableValues()).length === 0) return
    await sendToOtherBuild()
    storeValue(HANDED_OFF_KEY, 'true')
    pageWindow().location.reload()
  }
}

/**
 * Link the copy running Caelestis to the other build, if it turns out to be installed.
 * `awaiting` is `awaitingSettings()` as it was when this copy loaded its values.
 */
export const linkOtherBuild = (port: MessagePort, running: Build, awaiting: boolean): void => {
  port.onmessage = ({ data }) => {
    const reply = JSON.parse(String(data)) as Reply
    if (reply.type === 'done') {
      pending.get(reply.id)?.(reply)
      pending.delete(reply.id)
      return
    }
    link = port
    other = reply.build
    for (const listener of listeners) listener()
    handOff(running, reply.build, reply.empty, awaiting).catch((error: unknown) =>
      warn('install', 'could not hand settings over', String(error)),
    )
  }
}
