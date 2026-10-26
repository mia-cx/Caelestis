import { fileURLToPath } from 'node:url'
import { withSvartzHost } from '@svartz/vite/host'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default withSvartzHost(
  defineConfig({
    resolve: {
      alias: {
        'virtual:svartz/tailwind-sources.css':
          process.env.SVARTZ_TAILWIND_SOURCES_PATH ??
          fileURLToPath(new URL('./src/tailwind-sources.css', import.meta.url)),
      },
    },
    plugins: [tailwindcss(), sveltekit()],
  }),
)
