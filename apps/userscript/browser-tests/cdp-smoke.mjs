import { readFile } from 'node:fs/promises'

const port = process.env.CDP_PORT ?? '9222'
const bundle = process.env.BROWSER_BUNDLE
if (bundle === undefined) throw new Error('BROWSER_BUNDLE is required')
const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
  method: 'PUT',
  signal: AbortSignal.timeout(5000),
}).then((response) => response.json())
if (!target.webSocketDebuggerUrl) throw new Error('Could not create an owned CDP tab')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const calls = new Map()
const eventWaiters = new Map()
let sequence = 0
socket.addEventListener('message', ({ data }) => {
  const response = JSON.parse(data)
  if (response.id !== undefined) calls.get(response.id)?.(response)
  else if (response.method === 'Page.loadEventFired')
    eventWaiters.get('Page.loadEventFired')?.(response.params)
})
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => {
      calls.delete(id)
      reject(new Error(`CDP ${method} timed out`))
    }, 30000)
    calls.set(id, (response) => {
      clearTimeout(timeout)
      calls.delete(id)
      if (response.error !== undefined) reject(new Error(response.error.message))
      else resolve(response.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
const onceEvent = (method) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      eventWaiters.delete(method)
      reject(new Error(`CDP ${method} timed out`))
    }, 15000)
    eventWaiters.set(method, (params) => {
      clearTimeout(timeout)
      eventWaiters.delete(method)
      resolve(params)
    })
  })

const source = await readFile(bundle, 'utf8')
const freshPage = async (url) => {
  const loaded = onceEvent('Page.loadEventFired')
  await call('Page.navigate', { url })
  await loaded
  await call('Runtime.evaluate', { expression: source })
}
const runContract = async (expression, url = 'about:blank') => {
  await freshPage(url)
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails !== undefined)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP connection timed out')), 5000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
      { once: true },
    )
  })
  await call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await call('Page.enable')

  // Wplace renders in standards mode, where `html` is the scroller; about:blank is quirks mode.
  const menu = await runContract(
    'runOpenMenuBoundary()',
    'data:text/html,<!doctype html><title>open menu</title>',
  )
  if (typeof menu?.innerHeight !== 'number')
    throw new Error('open menu contract returned an incomplete result')

  const production = await runContract('runProductionBrowserBoundaries()')
  if (production?.canvasCaptured !== true || production?.scans?.length !== 3)
    throw new Error('production browser contracts returned an incomplete result')
} finally {
  socket.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, {
    signal: AbortSignal.timeout(5000),
  })
}

console.log('production CDP browser contracts passed')
