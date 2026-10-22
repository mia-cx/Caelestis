import type { DitheretteTemplateRecipe } from '@caelestis/shared'
import { createDitherette, type Ditherette, type Progress, type Rgba8Image } from 'ditherette'
import { processDitherette } from './ditherette-process.js'

/**
 * Ditherette's worker. The build bundles this file on its own and inlines the result as a string,
 * which the page starts from a `blob:` URL; see `ditherette.ts`.
 *
 * Ditherette's calls are synchronous, so this worker is what keeps a long dither off the page's
 * thread. It keeps the last decoded source, so changing a setting does not copy the image again.
 */

export type DitheretteWorkerRequest =
  | { readonly type: 'init'; readonly wasm: WebAssembly.Module }
  | {
      readonly type: 'process'
      readonly id: number
      readonly sourceKey: string
      /** Sent only when this worker does not already hold `sourceKey`. */
      readonly source?: Rgba8Image
      readonly recipe: DitheretteTemplateRecipe
    }

export type DitheretteWorkerReply =
  | { readonly type: 'ready' }
  | { readonly type: 'progress'; readonly id: number; readonly progress: Progress }
  | {
      readonly type: 'done'
      readonly id: number
      readonly indices: Uint8Array
      readonly opaque: number
    }
  | { readonly type: 'error'; readonly id: number | null; readonly message: string }

const scope = self as unknown as {
  postMessage: (reply: DitheretteWorkerReply, transfer?: Transferable[]) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<DitheretteWorkerRequest>) => void,
  ) => void
}

let processor: Promise<Ditherette> | null = null
let held: { readonly key: string; readonly image: Rgba8Image } | null = null

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const run = async (
  request: Extract<DitheretteWorkerRequest, { type: 'process' }>,
): Promise<void> => {
  if (request.source !== undefined) held = { key: request.sourceKey, image: request.source }
  if (held?.key !== request.sourceKey) throw new Error('the worker lost its source image')
  if (processor === null) throw new Error('the worker was not initialised')
  const artwork = processDitherette(await processor, held.image, request.recipe, (progress) =>
    scope.postMessage({ type: 'progress', id: request.id, progress }),
  )
  scope.postMessage({ type: 'done', id: request.id, ...artwork }, [artwork.indices.buffer])
}

scope.addEventListener('message', (event) => {
  const request = event.data
  if (request.type === 'init') {
    processor = createDitherette({ wasm: request.wasm })
    processor.then(
      () => scope.postMessage({ type: 'ready' }),
      (error: unknown) => scope.postMessage({ type: 'error', id: null, message: messageOf(error) }),
    )
    return
  }
  run(request).catch((error: unknown) =>
    scope.postMessage({ type: 'error', id: request.id, message: messageOf(error) }),
  )
})
