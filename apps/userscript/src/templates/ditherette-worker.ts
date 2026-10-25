import type { DitheretteEngine, DitheretteTemplateRecipe } from '@caelestis/shared'
import type { Progress, Rgba8Image } from 'ditherette'
import { processDitherette, processors } from './ditherette-process.js'

/**
 * Ditherette's worker. The build bundles this file on its own and inlines the result as a string,
 * which the page starts from a `blob:` URL; see `ditherette.ts`.
 *
 * The worker keeps a long dither off the page's thread, and keeps the last decoded source so
 * changing a setting does not copy the image again. GPU runs stop when cancelled; CPU calls are
 * synchronous, so the page stops those by terminating the worker.
 */

export type DitheretteWorkerRequest =
  | {
      readonly type: 'init'
      readonly wasm: WebAssembly.Module
      readonly gpuWasm: WebAssembly.Module | null
    }
  | {
      readonly type: 'process'
      readonly id: number
      readonly sourceKey: string
      /** Sent only when this worker does not already hold `sourceKey`. */
      readonly source?: Rgba8Image
      readonly recipe: DitheretteTemplateRecipe
    }
  | { readonly type: 'cancel'; readonly id: number }

export type DitheretteWorkerReply =
  | { readonly type: 'ready' }
  /** The engine a job runs on, before it starts, so the page knows how to stop it. */
  | { readonly type: 'started'; readonly id: number; readonly engine: DitheretteEngine }
  | { readonly type: 'progress'; readonly id: number; readonly progress: Progress }
  | {
      readonly type: 'done'
      readonly id: number
      readonly indices: Uint8Array
      readonly opaque: number
      readonly engine: DitheretteEngine
    }
  | {
      readonly type: 'error'
      readonly id: number | null
      readonly message: string
      readonly aborted?: boolean
    }

const scope = self as unknown as {
  postMessage: (reply: DitheretteWorkerReply, transfer?: Transferable[]) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<DitheretteWorkerRequest>) => void,
  ) => void
}

let processorFor: ReturnType<typeof processors> | null = null
let held: { readonly key: string; readonly image: Rgba8Image } | null = null
/** Every job not yet finished, so a cancel that arrives while it waits still stops it. */
const running = new Map<number, AbortController>()
let queue: Promise<void> = Promise.resolve()

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const run = async (
  request: Extract<DitheretteWorkerRequest, { type: 'process' }>,
): Promise<void> => {
  if (request.source !== undefined) held = { key: request.sourceKey, image: request.source }
  if (held?.key !== request.sourceKey) throw new Error('the worker lost its source image')
  if (processorFor === null) throw new Error('the worker was not initialised')
  const { image } = held
  const controller = running.get(request.id) ?? new AbortController()
  try {
    controller.signal.throwIfAborted()
    const processor = await processorFor(request.recipe.engine)
    controller.signal.throwIfAborted()
    scope.postMessage({
      type: 'started',
      id: request.id,
      engine: 'execution' in processor ? 'gpu' : 'cpu',
    })
    const artwork = await processDitherette(
      processor,
      image,
      request.recipe,
      (progress) => scope.postMessage({ type: 'progress', id: request.id, progress }),
      controller.signal,
    )
    scope.postMessage({ type: 'done', id: request.id, ...artwork }, [artwork.indices.buffer])
  } finally {
    running.delete(request.id)
  }
}

scope.addEventListener('message', (event) => {
  const request = event.data
  switch (request.type) {
    case 'init':
      processorFor = processors(request.wasm, request.gpuWasm)
      scope.postMessage({ type: 'ready' })
      return
    case 'cancel':
      running.get(request.id)?.abort()
      return
    case 'process':
      // A processor takes one call at a time: each job waits until the one before has stopped.
      running.set(request.id, new AbortController())
      queue = queue
        .then(() => run(request))
        .catch((error: unknown) =>
          scope.postMessage({
            type: 'error',
            id: request.id,
            message: messageOf(error),
            aborted: error instanceof DOMException && error.name === 'AbortError',
          }),
        )
  }
})
