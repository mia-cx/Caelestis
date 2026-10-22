import scalarWasm from 'ditherette:scalar-wasm'
import workerSource from 'ditherette:worker'
import type { DitheretteTemplateRecipe } from '@caelestis/shared'
import { createDitherette, type Ditherette, type Progress, type Rgba8Image } from 'ditherette'
import { warn } from '../debug.js'
import { type DitheretteArtwork, processDitherette } from './ditherette-process.js'
import type { DitheretteWorkerReply, DitheretteWorkerRequest } from './ditherette-worker.js'

/**
 * Running Ditherette recipes off the page's thread.
 *
 * One job runs at a time. Starting another, or aborting the running one, terminates the worker:
 * Ditherette's calls are synchronous and cannot stop halfway, and the editor only ever wants the
 * latest settings. A fresh worker starts from the already-compiled module.
 *
 * Without workers the same code runs in the page, which blocks while it works but still produces
 * the same artwork.
 */

export interface DitheretteJob {
  readonly recipe: DitheretteTemplateRecipe
  /** Decoded source pixels and a key that changes whenever they do. */
  readonly source: { readonly key: string; readonly image: Rgba8Image }
  readonly onProgress?: (progress: Progress) => void
  readonly signal?: AbortSignal
}

interface Running {
  readonly id: number
  readonly job: DitheretteJob
  readonly resolve: (artwork: DitheretteArtwork) => void
  readonly reject: (error: unknown) => void
}

interface Host {
  readonly worker: Worker
  readonly ready: Promise<void>
  sourceKey: string | null
}

let compiled: Promise<WebAssembly.Module> | null = null
let inPage: Promise<Ditherette> | null = null
let host: Host | null = null
let running: Running | null = null
let jobs = 0
let workersFailed = false

const wasmModule = (): Promise<WebAssembly.Module> => {
  compiled ??= WebAssembly.compile(scalarWasm)
  compiled.catch(() => {
    compiled = null
  })
  return compiled
}

const aborted = (): DOMException => new DOMException('Processing was replaced.', 'AbortError')

const stopHost = (): void => {
  host?.worker.terminate()
  host = null
}

const settle = (id: number, outcome: { artwork: DitheretteArtwork } | { error: unknown }): void => {
  if (running?.id !== id) return
  const finished = running
  running = null
  if ('artwork' in outcome) finished.resolve(outcome.artwork)
  else finished.reject(outcome.error)
}

const startHost = (module: WebAssembly.Module): Host => {
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  let worker: Worker
  try {
    worker = new Worker(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  let isReady = false
  let ready: (value: void) => void = () => {}
  let failed: (error: Error) => void = () => {}
  const started: Host = {
    worker,
    ready: new Promise<void>((resolve, reject) => {
      ready = resolve
      failed = reject
    }),
    sourceKey: null,
  }
  worker.addEventListener('message', (event: MessageEvent<DitheretteWorkerReply>) => {
    const reply = event.data
    if (reply.type === 'ready') {
      isReady = true
      ready()
    } else if (reply.type === 'progress') {
      if (running?.id === reply.id) running.job.onProgress?.(reply.progress)
    } else if (reply.type === 'done')
      settle(reply.id, { artwork: { indices: reply.indices, opaque: reply.opaque } })
    else if (reply.id === null) failed(new Error(reply.message))
    else settle(reply.id, { error: new Error(reply.message) })
  })
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'the Ditherette worker failed')
    if (host === started) stopHost()
    // Before it is ready, the job falls back to the page. After, the job itself crashed it.
    if (!isReady) failed(error)
    else if (running !== null) settle(running.id, { error })
  })
  worker.postMessage({ type: 'init', wasm: module } satisfies DitheretteWorkerRequest)
  return started
}

const runInWorker = async (current: Running): Promise<void> => {
  const module = await wasmModule()
  if (running !== current) return
  host ??= startHost(module)
  const target = host
  await target.ready
  if (running !== current || host !== target) return
  const { job } = current
  const sendSource = target.sourceKey !== job.source.key
  target.sourceKey = job.source.key
  target.worker.postMessage({
    type: 'process',
    id: current.id,
    sourceKey: job.source.key,
    ...(sendSource ? { source: job.source.image } : {}),
    recipe: job.recipe,
  } satisfies DitheretteWorkerRequest)
}

const runInPage = async (current: Running): Promise<void> => {
  inPage ??= wasmModule().then((wasm) => createDitherette({ wasm }))
  const processor = await inPage
  // Let the page paint the pending state before the synchronous call holds it.
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (running !== current) return
  const { job } = current
  settle(current.id, {
    artwork: processDitherette(processor, job.source.image, job.recipe, job.onProgress),
  })
}

const canUseWorkers = (): boolean =>
  !workersFailed && workerSource !== '' && typeof Worker === 'function'

/** Run one recipe. A newer job, or `signal`, rejects this one with an AbortError. */
export const runDitherette = (job: DitheretteJob): Promise<DitheretteArtwork> =>
  new Promise<DitheretteArtwork>((resolve, reject) => {
    if (job.signal?.aborted) {
      reject(aborted())
      return
    }
    if (running !== null) {
      settle(running.id, { error: aborted() })
      stopHost()
    }
    const current: Running = { id: ++jobs, job, resolve, reject }
    running = current
    job.signal?.addEventListener(
      'abort',
      () => {
        if (running !== current) return
        settle(current.id, { error: aborted() })
        stopHost()
      },
      { once: true },
    )
    const fail = (error: unknown): void => settle(current.id, { error })
    if (!canUseWorkers()) {
      runInPage(current).catch(fail)
      return
    }
    runInWorker(current).catch((error: unknown) => {
      if (running !== current) return
      // A page that refuses blob workers still gets its artwork, on its own thread.
      warn('install', 'Ditherette worker unavailable; processing in the page', String(error))
      workersFailed = true
      stopHost()
      runInPage(current).catch(fail)
    })
  })

/** Whether this browser can run Ditherette at all. Compiles the module once, as a warm-up. */
export const ditheretteAvailable = async (): Promise<boolean> => {
  try {
    await wasmModule()
    return true
  } catch (error) {
    warn('install', 'Ditherette cannot load in this browser', String(error))
    return false
  }
}
