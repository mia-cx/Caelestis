import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { API_VERSION_PATH } from '@caelestis/shared'
import adapter from '@sveltejs/adapter-cloudflare'
import nodeAdapter from '@sveltejs/adapter-node'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import {
  DEV_TUNNEL_HOST,
  FORMER_DASHBOARD_ORIGIN,
  LIVE_PATH,
  READ_PROXY,
} from './src/lib/deployment.ts'

const deploymentVersion = /^[0-9a-f]{40}$/i.test(process.env.CAELESTIS_BUILD_ID ?? '')
  ? (process.env.CAELESTIS_BUILD_ID ?? '').slice(0, 12)
  : 'development'

function cloudflareAdapter() {
  const cloudflare = adapter()
  return {
    ...cloudflare,
    async adapt(builder: Parameters<typeof cloudflare.adapt>[0]) {
      await cloudflare.adapt(builder)
      const entry = join(builder.getBuildDirectory('cloudflare'), '_worker.js')
      // The adapter serves static assets before SvelteKit's handle runs.
      renameSync(entry, join(builder.getBuildDirectory('cloudflare-tmp'), 'adapter-worker.js'))
      writeFileSync(
        entry,
        `import worker from '../cloudflare-tmp/adapter-worker.js'
import { redirectWww } from '../../src/lib/server/www-redirect.ts'

export default {
  ...worker,
  fetch(request, ...args) {
    return redirectWww(new URL(request.url)) ?? worker.fetch(request, ...args)
  },
}
`,
      )
    },
  }
}

export default defineConfig(({ command }) => {
  const node = process.env.CAELESTIS_TARGET === 'node'
  const varsFile = new URL('./.dev.vars', import.meta.url)
  const devVars =
    command === 'serve' && existsSync(varsFile) ? parseEnv(readFileSync(varsFile, 'utf8')) : {}

  return {
    // Vite must forward upgrades itself; its HTTP middleware cannot run the Worker socket proxy.
    server: {
      allowedHosts: [DEV_TUNNEL_HOST],
      // A cached dev module can import an older Svelte runtime and break hydration.
      headers: { 'Cache-Control': 'no-store' },
      proxy:
        devVars.CAELESTIS_SERVER && devVars.CAELESTIS_READ_TOKEN
          ? {
              [`${READ_PROXY}${API_VERSION_PATH}${LIVE_PATH}`]: {
                target: devVars.CAELESTIS_SERVER,
                changeOrigin: true,
                ws: true,
                rewrite: (path) => path.slice(READ_PROXY.length),
                headers: { authorization: `Bearer ${devVars.CAELESTIS_READ_TOKEN}` },
              },
            }
          : undefined,
    },
    define: {
      __CAELESTIS_FRONTEND_VERSION__: JSON.stringify(deploymentVersion),
    },
    resolve: {
      // Node builds and tests run outside workerd, so they get a stub with no bindings.
      alias:
        node || process.env.VITEST === 'true'
          ? {
              'cloudflare:workers': fileURLToPath(
                new URL('./node/cloudflare-workers.js', import.meta.url),
              ),
            }
          : undefined,
      // Component tests run in happy-dom and need Svelte's client entry point rather than its SSR
      // default. Production browser builds already select this condition themselves.
      conditions: process.env.VITEST === 'true' ? ['browser'] : undefined,
    },
    plugins: [
      tailwindcss(),
      sveltekit({
        compilerOptions: {
          runes: ({ filename }) =>
            filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
        },

        adapter: node ? nodeAdapter({ out: 'build' }) : cloudflareAdapter(),
        // The former dashboard host posts saved browser state to /moved (see dashboard-move.ts).
        csrf: { trustedOrigins: [FORMER_DASHBOARD_ORIGIN] },
      }),
    ],
  }
})
