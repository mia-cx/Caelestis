import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * Ditherette ships its WebAssembly beside its JavaScript and finds it through `import.meta.url`,
 * which a single-file userscript does not have. This plugin inlines the published package's scalar
 * binary as `ditherette:scalar-wasm` and a separately bundled worker as `ditherette:worker`; the
 * userscript hands the binary to Ditherette itself.
 */
export const ditherettePlugin = ({ minify }) => ({
  name: 'ditherette',
  setup(plugin) {
    plugin.onResolve({ filter: /^ditherette:/ }, (args) => ({
      path: args.path,
      namespace: 'ditherette',
    }))
    plugin.onLoad({ filter: /^ditherette:scalar-wasm$/, namespace: 'ditherette' }, () => {
      const path = fileURLToPath(
        new URL('./wasm/scalar/ditherette_wasm_bg.wasm', import.meta.resolve('ditherette')),
      )
      return { contents: readFileSync(path), loader: 'binary', watchFiles: [path] }
    })
    plugin.onLoad({ filter: /^ditherette:worker$/, namespace: 'ditherette' }, async () => {
      const worker = await build({
        entryPoints: [resolve(here, 'src/templates/ditherette-worker.ts')],
        absWorkingDir: here,
        bundle: true,
        write: false,
        format: 'iife',
        target: 'es2022',
        minify,
        metafile: true,
        logLevel: 'warning',
      })
      return {
        contents: `export default ${JSON.stringify(worker.outputFiles[0].text)}`,
        loader: 'js',
        watchFiles: Object.keys(worker.metafile.inputs).map((input) => resolve(here, input)),
      }
    })
  },
})
