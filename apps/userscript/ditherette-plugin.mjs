import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * Ditherette's GPU engine loads its glue module from `new URL(…, import.meta.url)`. A single-file
 * userscript has no module URL, so that import fails and Ditherette quietly falls back to the CPU.
 * The glue is ordinary JavaScript in the package, so a static import lets esbuild bundle it.
 */
const GPU_GLUE =
  /const url = new URL\('\.\/wasm\/gpu\/ditherette_wasm\.factory\.js', import\.meta\.url\);\s*const factory = \(await import\(\/\* @vite-ignore \*\/ url\.href\)\);/

const wasmPath = (variant) =>
  fileURLToPath(
    new URL(`./wasm/${variant}/ditherette_wasm_bg.wasm`, import.meta.resolve('ditherette')),
  )

/** Bundle Ditherette's GPU glue, and inline its scalar and GPU binaries for the page to hand over. */
const ditheretteAssets = (plugin) => {
  plugin.onResolve({ filter: /^ditherette:(scalar|gpu)-wasm$/ }, (args) => ({
    path: args.path,
    namespace: 'ditherette',
  }))
  plugin.onLoad({ filter: /^ditherette:(scalar|gpu)-wasm$/, namespace: 'ditherette' }, (args) => {
    const path = wasmPath(args.path === 'ditherette:gpu-wasm' ? 'gpu' : 'scalar')
    return { contents: readFileSync(path), loader: 'binary', watchFiles: [path] }
  })
  plugin.onLoad({ filter: /[\\/]ditherette[\\/]dist[\\/]gpu-(effects|dither)\.js$/ }, (args) => {
    const source = readFileSync(args.path, 'utf8')
    if (!GPU_GLUE.test(source))
      throw new Error(`Ditherette's GPU glue import changed in ${args.path}`)
    return {
      contents: source.replace(
        GPU_GLUE,
        "const factory = await import('./wasm/gpu/ditherette_wasm.factory.js');",
      ),
      loader: 'js',
    }
  })
}

/**
 * Ditherette ships its WebAssembly beside its JavaScript and finds it through `import.meta.url`,
 * which a single-file userscript does not have. This plugin inlines the published package's
 * binaries as `ditherette:scalar-wasm` and `ditherette:gpu-wasm`, and a separately bundled worker
 * as `ditherette:worker`; the userscript hands the binaries to Ditherette itself.
 */
export const ditherettePlugin = ({ minify }) => ({
  name: 'ditherette',
  setup(plugin) {
    ditheretteAssets(plugin)
    plugin.onResolve({ filter: /^ditherette:worker$/ }, (args) => ({
      path: args.path,
      namespace: 'ditherette',
    }))
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
        plugins: [{ name: 'ditherette-assets', setup: ditheretteAssets }],
      })
      return {
        contents: `export default ${JSON.stringify(worker.outputFiles[0].text)}`,
        loader: 'js',
        watchFiles: Object.keys(worker.metafile.inputs).map((input) => resolve(here, input)),
      }
    })
  },
})
