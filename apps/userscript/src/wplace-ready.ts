/**
 * When Wplace has finished booting, as far as anything that touches its modules is concerned.
 *
 * Caelestis runs at `document-start`, and some of it evaluates Wplace's own code: the native
 * template store is found by `import()`ing Wplace's content-hashed chunks. Those chunks read the
 * message catalog at module top level, and the catalog is only there once Wplace's `init` hook has
 * awaited its own locale import. Evaluating such a chunk earlier throws, and an ES module that threw
 * during evaluation stays failed for the life of the document — so Wplace's later import of the
 * same chunk fails too, and the map is never built. That is issue #416.
 *
 * `DOMContentLoaded` says nothing about any of this: it fires before Wplace's app has hydrated.
 * The MapLibre canvas does. Wplace only creates its map from a rendered page node, and the page
 * nodes are imported after `init` resolved, so once the canvas exists every chunk of Wplace's that
 * we might evaluate can be evaluated safely.
 *
 * There is deliberately no timeout. If Wplace never gets as far as its map, evaluating its modules
 * ourselves is exactly the thing that must not happen; whatever waited simply never runs.
 */

/** The map surface Wplace builds once its page has rendered. */
const MAP_CANVAS = 'canvas.maplibregl-canvas'

/** How often to look again while the canvas is absent. */
const POLL_MS = 250

export const isWplaceMapReady = (root: Pick<Document, 'querySelector'> = document): boolean =>
  root.querySelector(MAP_CANVAS)?.isConnected === true

/** Resolve once Wplace's map canvas exists in the document. */
export const whenWplaceMapReady = (
  ready: () => boolean = isWplaceMapReady,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> => {
  const poll = async (): Promise<void> => {
    while (!ready()) await wait(POLL_MS)
  }
  return poll()
}
