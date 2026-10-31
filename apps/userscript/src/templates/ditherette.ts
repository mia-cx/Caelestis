import gpuWasm from 'ditherette:gpu-wasm'
import scalarWasm from 'ditherette:scalar-wasm'
import workerSource from 'ditherette:worker'
import type { DitheretteEngine, DitheretteTemplateRecipe } from '@caelestis/shared'
import type { Curve, Progress, Rgba8Image } from 'ditherette'
import { warn } from '../debug.js'
import {
  analysePaletteFit,
  type DitheretteArtwork,
  type FitAnalysis,
  processDitherette,
  processors,
} from './ditherette-process.js'
import type { DitheretteWorkerReply, DitheretteWorkerRequest } from './ditherette-worker.js'

export type { DitheretteEngine } from '@caelestis/shared'
export type { DitheretteArtwork } from './ditherette-process.js'

/**
 * Running Ditherette recipes off the page's thread, on the recipe's engine.
 *
 * One job runs at a time, and the studio only ever wants the latest settings. A newer job, or an
 * abort, cancels a GPU run in place, so the worker keeps its device. A CPU run is a synchronous
 * call that cannot stop halfway, so it terminates the worker; a fresh one starts from the
 * already-compiled modules.
 *
 * Without workers the same code runs in the page, which blocks during CPU runs but still produces
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
  /** Set once the worker reports which engine took the job. */
  engine: DitheretteEngine | null
}

interface Modules {
  readonly wasm: WebAssembly.Module
  /** Null where the page has no WebGPU, so nothing compiles a binary it cannot use. */
  readonly gpuWasm: WebAssembly.Module | null
}

interface Host {
  readonly worker: Worker
  readonly ready: Promise<void>
  sourceKey: string | null
}

let compiled: Promise<Modules> | null = null
let inPage: ReturnType<typeof processors> | null = null
let host: Host | null = null
let running: Running | null = null
let jobs = 0
let workersFailed = false

const compileModules = (): Promise<Modules> => {
  compiled ??= Promise.all([
    WebAssembly.compile(scalarWasm),
    'gpu' in navigator ? WebAssembly.compile(gpuWasm) : null,
  ]).then(([wasm, gpu]) => ({ wasm, gpuWasm: gpu }))
  compiled.catch(() => {
    compiled = null
  })
  return compiled
}

const aborted = (): DOMException => new DOMException('Processing was replaced.', 'AbortError')

/** Palette-fit analyses waiting on the worker, by request id. */
const pendingFits = new Map<
  number,
  { readonly resolve: (curves: Curve[]) => void; readonly reject: (error: unknown) => void }
>()

const stopHost = (): void => {
  host?.worker.terminate()
  host = null
  for (const pending of pendingFits.values()) pending.reject(aborted())
  pendingFits.clear()
}

/**
 * Stop the running job. Only a confirmed CPU run terminates the worker; a GPU run, or one still
 * starting its engine, is cancelled in place.
 */
const stopRunning = (): void => {
  if (running === null) return
  const stopped = running
  settle(stopped.id, { error: aborted() })
  if (stopped.engine === 'cpu') stopHost()
  else
    host?.worker.postMessage({ type: 'cancel', id: stopped.id } satisfies DitheretteWorkerRequest)
}

const settle = (id: number, outcome: { artwork: DitheretteArtwork } | { error: unknown }): void => {
  if (running?.id !== id) return
  const finished = running
  running = null
  if ('artwork' in outcome) finished.resolve(outcome.artwork)
  else finished.reject(outcome.error)
}

const startHost = (modules: Modules): Host => {
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
    switch (reply.type) {
      case 'ready':
        isReady = true
        ready()
        return
      case 'started':
        if (running?.id === reply.id) running.engine = reply.engine
        return
      case 'progress':
        if (running?.id === reply.id) running.job.onProgress?.(reply.progress)
        return
      case 'done':
        settle(reply.id, {
          artwork: { indices: reply.indices, opaque: reply.opaque, engine: reply.engine },
        })
        return
      case 'fit':
        pendingFits.get(reply.id)?.resolve(reply.curves)
        pendingFits.delete(reply.id)
        return
      case 'error': {
        if (reply.id === null) {
          failed(new Error(reply.message))
          return
        }
        const error = reply.aborted === true ? aborted() : new Error(reply.message)
        const fit = pendingFits.get(reply.id)
        pendingFits.delete(reply.id)
        if (fit !== undefined) fit.reject(error)
        else settle(reply.id, { error })
      }
    }
  })
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'the Ditherette worker failed')
    if (host === started) stopHost()
    // Before it is ready, the job falls back to the page. After, the job itself crashed it.
    if (!isReady) failed(error)
    else if (running !== null) settle(running.id, { error })
  })
  worker.postMessage({ type: 'init', ...modules } satisfies DitheretteWorkerRequest)
  return started
}

const runInWorker = async (current: Running): Promise<void> => {
  const modules = await compileModules()
  if (running !== current) return
  host ??= startHost(modules)
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
  const processor = await (await pageProcessors()).forEngine(current.job.recipe.engine)
  // Let the page paint the pending state before a synchronous CPU call holds it.
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (running !== current) return
  const { job } = current
  const controller = new AbortController()
  job.signal?.addEventListener('abort', () => controller.abort(), { once: true })
  current.engine = 'execution' in processor ? 'gpu' : 'cpu'
  settle(current.id, {
    artwork: await processDitherette(
      processor,
      job.source.image,
      job.recipe,
      job.onProgress,
      controller.signal,
    ),
  })
}

const canUseWorkers = (): boolean =>
  !workersFailed && workerSource !== '' && typeof Worker === 'function'

/**
 * Run one recipe on its engine, or on the CPU where a GPU recipe meets no GPU; the artwork names
 * the engine that ran. A newer job, or `signal`, rejects this one with an AbortError.
 */
export const runDitherette = (job: DitheretteJob): Promise<DitheretteArtwork> =>
  new Promise<DitheretteArtwork>((resolve, reject) => {
    if (job.signal?.aborted) {
      reject(aborted())
      return
    }
    stopRunning()
    const current: Running = { id: ++jobs, job, resolve, reject, engine: null }
    running = current
    job.signal?.addEventListener(
      'abort',
      () => {
        if (running === current) stopRunning()
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

const pageProcessors = async (): Promise<ReturnType<typeof processors>> => {
  if (inPage === null) {
    const { wasm, gpuWasm: gpu } = await compileModules()
    inPage ??= processors(wasm, gpu)
  }
  return inPage
}

/**
 * The curves a palette fit with `curves: null` would apply, analysed on the CPU after any running
 * job. A CPU run replaced before it finishes takes the worker, and this, with it.
 */
export const analyseFit = async (job: {
  readonly analysis: FitAnalysis
  readonly source: { readonly key: string; readonly image: Rgba8Image }
}): Promise<Curve[]> => {
  if (!canUseWorkers())
    return analysePaletteFit(await (await pageProcessors()).cpu(), job.source.image, job.analysis)
  const modules = await compileModules()
  host ??= startHost(modules)
  const target = host
  await target.ready
  const id = ++jobs
  const sendSource = target.sourceKey !== job.source.key
  target.sourceKey = job.source.key
  return await new Promise<Curve[]>((resolve, reject) => {
    pendingFits.set(id, { resolve, reject })
    target.worker.postMessage({
      type: 'analyse-fit',
      id,
      sourceKey: job.source.key,
      ...(sendSource ? { source: job.source.image } : {}),
      analysis: job.analysis,
    } satisfies DitheretteWorkerRequest)
  })
}

/** Whether this browser can run Ditherette at all. Compiles the modules once, as a warm-up. */
export const ditheretteAvailable = async (): Promise<boolean> => {
  try {
    await compileModules()
    return true
  } catch (error) {
    warn('install', 'Ditherette cannot load in this browser', String(error))
    return false
  }
}
