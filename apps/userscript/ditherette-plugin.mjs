import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))
const entry = import.meta.resolve('ditherette')
const variants = ['scalar', 'gpu']

const wasmPath = (variant) =>
  fileURLToPath(new URL(`./wasm/${variant}/ditherette_wasm_bg.wasm`, entry))

/**
 * The userscript's `@resource` entries for Ditherette's binaries: the installed package's own files
 * on jsDelivr, pinned to its version and hash, so the lockfile decides what users download.
 * `src/templates/ditherette-resources.ts` reads them back by name.
 */
export const ditheretteResources = () => {
  const packageJson = new URL('../package.json', entry)
  const { version } = JSON.parse(readFileSync(packageJson, 'utf8'))
  const root = fileURLToPath(new URL('.', packageJson))
  return variants.map((variant) => {
    const path = wasmPath(variant)
    const hash = createHash('sha256').update(readFileSync(path)).digest('base64')
    const file = relative(root, path).split('\\').join('/')
    return {
      name: `ditherette-${variant}`,
      url: `https://cdn.jsdelivr.net/npm/ditherette@${version}/${file}#sha256=${hash}`,
    }
  })
}

/** Inline Ditherette's scalar and GPU binaries as `ditherette:scalar-wasm` and `ditherette:gpu-wasm`. */
const ditheretteAssets = (plugin) => {
  plugin.onResolve({ filter: /^ditherette:(scalar|gpu)-wasm$/ }, (args) => ({
    path: args.path,
    namespace: 'ditherette',
  }))
  plugin.onLoad({ filter: /^ditherette:(scalar|gpu)-wasm$/, namespace: 'ditherette' }, (args) => {
    const path = wasmPath(args.path === 'ditherette:gpu-wasm' ? 'gpu' : 'scalar')
    return { contents: readFileSync(path), loader: 'binary', watchFiles: [path] }
  })
}

/**
 * Ditherette ships its WebAssembly beside its JavaScript and finds it through `import.meta.url`,
 * which a single-file userscript does not have. This plugin provides `ditherette:wasm`, which loads
 * a binary by variant, and a separately bundled worker as `ditherette:worker`; the userscript hands
 * the binaries to Ditherette itself.
 *
 * `wasm: 'inline'` bundles the binaries. `wasm: 'resource'` reads them from the userscript's
 * `@resource`s (see `ditheretteResources`), which keeps the release userscript small enough for
 * Greasy Fork. The extension inlines them: MV3 allows no remotely hosted code.
 */
export const ditherettePlugin = ({ minify, wasm = 'inline' }) => ({
  name: 'ditherette',
  setup(plugin) {
    ditheretteAssets(plugin)
    plugin.onResolve({ filter: /^ditherette:wasm$/ }, (args) =>
      wasm === 'resource'
        ? { path: resolve(here, 'src/templates/ditherette-resources.ts') }
        : { path: args.path, namespace: 'ditherette' },
    )
    plugin.onLoad({ filter: /^ditherette:wasm$/, namespace: 'ditherette' }, () => ({
      contents: `import scalar from 'ditherette:scalar-wasm'
import gpu from 'ditherette:gpu-wasm'
export default async (variant) => (variant === 'gpu' ? gpu : scalar)`,
      loader: 'js',
    }))
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
