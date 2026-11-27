import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * `import source from 'worker:<name>'` is `src/<name>-worker.ts`, bundled on its own into a string
 * the page starts from a Blob URL: a userscript is one file, with nowhere to put a second.
 */
export const workerPlugin = ({ minify }) => ({
  name: 'workers',
  setup(plugin) {
    plugin.onResolve({ filter: /^worker:[\w-]+$/ }, (args) => ({
      path: args.path,
      namespace: 'worker',
    }))
    plugin.onLoad({ filter: /.*/, namespace: 'worker' }, async ({ path }) => {
      const name = path.slice('worker:'.length)
      const worker = await build({
        entryPoints: [resolve(here, `src/${name}-worker.ts`)],
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
