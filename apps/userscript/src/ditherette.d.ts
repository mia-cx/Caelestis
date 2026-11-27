/**
 * Ditherette's WebAssembly binary for `variant`. The build either inlines the published package's
 * own files or reads the release userscript's `@resource`s; see `ditherette-plugin.mjs`.
 */
declare module 'ditherette:wasm' {
  const load: (variant: 'scalar' | 'gpu') => Promise<BufferSource>
  export default load
}

/** `templates/ditherette-worker.ts`, bundled on its own. Empty where no worker is built. */
declare module 'ditherette:worker' {
  const source: string
  export default source
}

/** `src/<name>-worker.ts`, bundled on its own into a string; see `worker-plugin.mjs`. */
declare module 'worker:*' {
  const source: string
  export default source
}
