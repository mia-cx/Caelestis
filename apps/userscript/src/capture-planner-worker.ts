import { type PlanRequest, planProposals } from './capture-planning.js'

/**
 * The capture planner on a thread of its own, so an administrator can re-plan continuously while
 * the map stays smooth. Built into a string by `worker-plugin.mjs` and started from a Blob URL.
 */

interface Job extends PlanRequest {
  readonly id: number
}

self.onmessage = async ({ data }: MessageEvent<Job>) => {
  try {
    const proposals = await planProposals(data)
    const buffers = proposals.flatMap(({ area }) => (area === null ? [] : [area.mask.buffer]))
    self.postMessage({ id: data.id, proposals }, { transfer: buffers })
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) })
  }
}
