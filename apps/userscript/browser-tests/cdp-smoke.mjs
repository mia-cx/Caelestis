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
let sequence = 0
socket.addEventListener('message', ({ data }) => {
  const response = JSON.parse(data)
  if (response.id !== undefined) calls.get(response.id)?.(response)
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
  await call('Page.navigate', { url: 'about:blank' })
  await call('Runtime.evaluate', { expression: await readFile(bundle, 'utf8') })
  const result = await call('Runtime.evaluate', {
    expression: 'runProductionBrowserBoundaries()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text)
  if (result.result.value?.canvasCaptured !== true || result.result.value?.scans?.length !== 3)
    throw new Error('production browser contracts returned an incomplete result')
} finally {
  socket.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, {
    signal: AbortSignal.timeout(5000),
  })
}

console.log('production CDP browser contracts passed')
