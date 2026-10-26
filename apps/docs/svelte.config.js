import { existsSync } from 'node:fs'
import adapter from '@sveltejs/adapter-static'

// Svartz copies vault attachments into the build after SvelteKit lists its assets, so the
// prerender crawler sees a link to one as a missing page. It still fails on a missing attachment.
const vaultAsset = (path) =>
  existsSync(new URL(`./.svartz/vaults/docs/artifacts/assets${path.replace(/\/$/, '')}`, import.meta.url))

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    adapter: adapter({ pages: 'build', assets: 'build', fallback: '404.html', strict: true }),
    prerender: {
      handleHttpError: ({ path, message }) => {
        if (!vaultAsset(decodeURI(path))) throw new Error(message)
      },
    },
  },
}
