/** Ditherette's scalar WebAssembly binary. The build inlines the published package's own file. */
declare module 'ditherette:scalar-wasm' {
  const bytes: Uint8Array<ArrayBuffer>
  export default bytes
}

/** Ditherette's GPU engine binary, inlined the same way. */
declare module 'ditherette:gpu-wasm' {
  const bytes: Uint8Array<ArrayBuffer>
  export default bytes
}

/** `templates/ditherette-worker.ts`, bundled on its own. Empty where no worker is built. */
declare module 'ditherette:worker' {
  const source: string
  export default source
}
