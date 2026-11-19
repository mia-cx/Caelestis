import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { withSvartzHost } from '@svartz/vite/host'
import adapter from '@sveltejs/adapter-static'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Svartz copies vault attachments into the build after SvelteKit lists its assets, so the
// prerender crawler sees a link to one as a missing page. It still fails on a missing attachment.
const vaultAsset = (path: string) =>
  existsSync(
    new URL(`./.svartz/vaults/docs/artifacts/assets${path.replace(/\/$/, '')}`, import.meta.url),
  )

export default withSvartzHost(
  defineConfig({
    resolve: {
      alias: {
        'virtual:svartz/tailwind-sources.css':
          process.env.SVARTZ_TAILWIND_SOURCES_PATH ??
          fileURLToPath(new URL('./src/tailwind-sources.css', import.meta.url)),
      },
    },
    plugins: [
      tailwindcss(),
      sveltekit({
        adapter: adapter({ pages: 'build', assets: 'build', fallback: '404.html', strict: true }),
        prerender: {
          handleHttpError: ({ path, message }) => {
            if (!vaultAsset(decodeURI(path))) throw new Error(message)
          },
        },
      }),
    ],
  }),
)
