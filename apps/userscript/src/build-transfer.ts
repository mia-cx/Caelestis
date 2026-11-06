import { warn } from './debug.js'
import type { Build } from './page-claim.js'
import { pageWindow } from './page-world.js'
import {
  LOCAL_KEY_PREFIX,
  portableValues,
  replacePortableValues,
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

/** Set in the userscript once it handed its values to the extension; it then yields to it. */
export const HANDED_OFF_KEY = `${LOCAL_KEY_PREFIX}handed-off`

const MEETING = '__caelestisMeeting'

/**
 * This copy's end of the channel to the other build, which may not be installed at all.
 *
 * Both copies call this at document start, before any Wplace script runs. The first leaves the
 * other end on the page's `window`; the second takes it. An end nobody took is removed the moment
 * the page's first `<script>` element appears: the parser runs pending observers before it runs a
 * script, so no Wplace script ever sees the offer and poses as the other build.
 */
export const meetOtherBuild = (): MessagePort => {
  const page = pageWindow() as unknown as Record<string, unknown>
  const offered = page[MEETING]
  if (offered !== undefined) {
    delete page[MEETING]
    return offered as MessagePort
  }
  const channel = new MessageChannel()
  Object.defineProperty(page, MEETING, { value: channel.port2, configurable: true })
  const observer = new MutationObserver((records) => {
    const taken = page[MEETING] !== channel.port2
    const scriptAdded = records.some((record) =>
      [...record.addedNodes].some((node) => node.nodeName === 'SCRIPT'),
    )
    if (!taken && !scriptAdded) return
    if (!taken) delete page[MEETING]
    observer.disconnect()
  })
  observer.observe(document, { childList: true, subtree: true })
  return channel.port1
}

/** Running copy to serving copy. */
type Request =
  | { readonly type: 'read'; readonly id: number }
  | { readonly type: 'replace'; readonly id: number; readonly values: Record<string, string> }
  /** Read, and remember the hand-off: only the userscript is ever asked. */
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
        if (request.type === 'replace') replacePortableValues(request.values)
        if (request.type === 'hand-off') storeValue(HANDED_OFF_KEY, 'true')
        await syncStoredValues()
        const values = request.type === 'replace' ? {} : { values: portableValues() }
        post(port, { type: 'done', id: request.id, ok: true, ...values })
      } catch (error) {
        warn('install', `could not ${request.type} for the other build`, String(error))
        post(port, { type: 'done', id: request.id, ok: false })
      }
    })()
  }
  post(port, { type: 'hello', build, empty: Object.keys(portableValues()).length === 0 })
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

const adoptAndReload = async (values: Record<string, string>): Promise<void> => {
  replacePortableValues(values)
  await syncStoredValues()
  pageWindow().location.reload()
}

/** Replace this build's servers and settings with the other build's, then reload. */
export const importFromOtherBuild = async (): Promise<void> =>
  adoptAndReload(await ask({ type: 'read', id: ++lastRequest }))

/** Replace the other build's servers and settings with this build's. */
export const sendToOtherBuild = async (): Promise<void> => {
  await syncStoredValues()
  await ask({ type: 'replace', id: ++lastRequest, values: portableValues() })
}

/**
 * The first switch, with no button: the userscript's values fill an extension that has none, and
 * the userscript yields from then on.
 */
const handOff = async (running: Build, from: Build, empty: boolean, startedEmpty: boolean) => {
  if (running === 'extension' && from === 'userscript' && startedEmpty && !empty) {
    await adoptAndReload(await ask({ type: 'hand-off', id: ++lastRequest }))
  } else if (running === 'userscript' && from === 'extension' && empty) {
    if (Object.keys(portableValues()).length === 0) return
    await sendToOtherBuild()
    storeValue(HANDED_OFF_KEY, 'true')
    pageWindow().location.reload()
  }
}

/**
 * Link the copy running Caelestis to the other build, if it turns out to be installed.
 * `startedEmpty` says whether this copy had no stored values when it loaded.
 */
export const linkOtherBuild = (port: MessagePort, running: Build, startedEmpty: boolean): void => {
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
    handOff(running, reply.build, reply.empty, startedEmpty).catch((error: unknown) =>
      warn('install', 'could not hand settings over', String(error)),
    )
  }
}
