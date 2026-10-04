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
  else if (
    response.method === 'Runtime.bindingCalled' &&
    response.params.name === 'contractInput'
  ) {
    const { id, input } = JSON.parse(response.params.payload)
    void (async () => {
      if (input.key) {
        const code = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }[
          input.key
        ]
        await call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: input.key,
          code: input.key,
          windowsVirtualKeyCode: code,
          text: input.key === 'Enter' ? '\r' : undefined,
        })
        await call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: input.key,
          code: input.key,
          windowsVirtualKeyCode: code,
        })
      } else {
        const { x, y, button = 'left' } = input
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await call('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button,
          clickCount: 1,
        })
        await call('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount: 1,
        })
      }
      await call('Runtime.evaluate', { expression: `window.contractInputDone(${id})` })
    })().catch(async (error) => {
      await call('Runtime.evaluate', {
        expression: `window.contractInputDone(${id}, ${JSON.stringify(error.message)})`,
      })
    })
  }
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
// Page-side half of the `contractInput` binding: contracts await trusted CDP input through it.
const inputBridge = `
  let inputSequence = 0;
  const inputs = new Map();
  window.browserInput = (input) => new Promise((resolve, reject) => {
    const id = ++inputSequence;
    inputs.set(id, { resolve, reject });
    window.contractInput(JSON.stringify({ id, input }));
  });
  window.contractInputDone = (id, error) => {
    const pending = inputs.get(id);
    inputs.delete(id);
    if (error) pending.reject(new Error(error)); else pending.resolve();
  };
`
const freshPage = async (url) => {
  const loaded = onceEvent('Page.loadEventFired')
  await call('Page.navigate', { url })
  await loaded
  // Navigation drops the binding, so every fresh document needs it again.
  await call('Runtime.addBinding', { name: 'contractInput' })
  await call('Runtime.evaluate', { expression: inputBridge })
  const evaluated = await call('Runtime.evaluate', { expression: source })
  if (evaluated.exceptionDetails !== undefined)
    throw new Error(
      evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text,
    )
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
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  })
  await call('Page.enable')

  // Wplace renders in standards mode, where `html` is the scroller; about:blank is quirks mode.
  const menu = await runContract(
    'runOpenMenuBoundary()',
    'data:text/html,<!doctype html><title>open menu</title>',
  )
  if (typeof menu?.innerHeight !== 'number')
    throw new Error('open menu contract returned an incomplete result')

  const production = await runContract('runProductionBrowserBoundaries()')
  if (
    production?.canvasCaptured !== true ||
    production?.scans?.length !== 3 ||
    production?.fontStacks !== true
  )
    throw new Error('production browser contracts returned an incomplete result')
  if (production?.surfaces?.nativeDialogExits !== 4)
    throw new Error('panel surface contracts returned an incomplete result')
} finally {
  socket.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, {
    signal: AbortSignal.timeout(5000),
  })
}

console.log('production CDP browser contracts passed')
